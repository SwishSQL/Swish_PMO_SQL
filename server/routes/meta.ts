import { Router } from 'express';
import type { Request } from 'express';
import { db } from '../db';
import { HttpError, canManageAccounts, isOwner, issueInvite, requireAccountManager, route } from '../auth';
import { mapDepartment, mapQuarter, mapRole, mapTask, mapUser } from '../mappers';
import { date, idParam, optInt, optStr, str } from '../validate';
import type { Meta } from '../../shared/types';
import { addDays, diffDays, todayIso } from '../../shared/dates';
import {
  ADMIN_ROLE_ID,
  COMPANY_DOMAIN,
  PERMISSION_KEYS,
  isCompanyEmail,
  normalizePermissions,
} from '../../shared/permissions';
import { logActivity } from '../service';
import { directory, linkPeople, mergeName } from '../people';
import { buildBackup } from '../backup';
import { loadHolidays } from '../calendar';
import { mailDiagnostics, mailEnabled, sendMail } from '../mail';

export const metaRouter = Router();

metaRouter.get(
  '/meta',
  route(async (req, res) => {
    const [users, departments, quarters, roles, holidays] = await Promise.all([
      db.query('SELECT * FROM users ORDER BY name'),
      db.query('SELECT * FROM departments ORDER BY color_slot, name'),
      db.query('SELECT * FROM quarters ORDER BY year, q'),
      db.query('SELECT * FROM roles ORDER BY protected DESC, created_at, name'),
      loadHolidays(db),
    ]);
    const today = todayIso();
    const qs = quarters.rows.map(mapQuarter);
    const current = qs.find((q) => q.startsOn <= today && q.endsOn >= today) ?? qs[qs.length - 1] ?? null;
    // How my password was last set: by me, or through a setup link someone made.
    const { rows: sec } = await db.query(
      `SELECT u.password_set_at, u.temp_password, l.name AS link_by FROM users u LEFT JOIN users l ON l.id = u.password_link_by WHERE u.id = $1`,
      [req.user!.id],
    );
    const meta: Meta = {
      me: req.user!,
      myPassword: {
        setAt: sec[0]?.password_set_at ? new Date(sec[0].password_set_at).toISOString() : null,
        viaLinkFrom: sec[0]?.link_by ?? null,
      },
      permissions: [...(req.perms ?? [])],
      isOwner: isOwner(req.user!.email),
      canManageUsers: canManageAccounts(req),
      mustChangePassword: Boolean(sec[0]?.temp_password),
      emailSignIn: mailEnabled(),
      roles: roles.rows.map(mapRole),
      users: users.rows.map(mapUser),
      departments: departments.rows.map(mapDepartment),
      quarters: qs,
      currentQuarterId: current?.id ?? null,
      today,
      holidays,
    };
    res.json(meta);
  }),
);

metaRouter.get(
  '/my-work',
  route(async (req, res) => {
    const { rows } = await db.query(
      `SELECT t.*, p.code AS project_code, p.name AS project_name, p.name_ar AS project_name_ar,
              CASE WHEN t.assignee_id = $1 THEN 0 ELSE 1 END AS co_owner
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE (t.assignee_id = $1 OR EXISTS (SELECT 1 FROM task_coowners c WHERE c.task_id = t.id AND c.user_id = $1))
          AND t.kind <> 'summary' AND t.status <> 'cancelled' AND p.archived = 0
        ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.end_date, t.id`,
      [req.user!.id],
    );
    res.json(
      rows.map((r) => ({
        ...mapTask(r),
        // Mine as the owner, or only named among the co-owners.
        role: r.co_owner ? 'coOwner' : 'owner',
        projectCode: r.project_code,
        projectName: r.project_name,
        projectNameAr: r.project_name_ar,
      })),
    );
  }),
);

// ---- Users and roles: the owner and the system admins -----------------------------
// No role, not even PMO admin, can add accounts or change permissions. Only
// the owner, and system admins the owner appoints, can. The owner account is
// always active, so this can never lock the system.

const manage = requireAccountManager;

/**
 * Who may touch whom: the owner can change anyone but the owner's protected
 * fields. A system admin cannot change the owner or another system admin, so
 * admins cannot remove each other.
 */
function assertCanTouch(req: Request, target: { email: string; is_system_admin: boolean }) {
  if (isOwner(req.user!.email)) return;
  if (isOwner(target.email)) throw new HttpError(403, 'Only the owner can change the owner account.');
  if (target.is_system_admin) throw new HttpError(403, 'Only the owner can change a system admin account.');
}

async function roleExists(id: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM roles WHERE id = $1', [id]);
  return rows.length > 0;
}

async function loadUser(id: number) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'User not found.');
  return rows[0];
}

/**
 * A department head starts projects in the departments they head (Departments tab). So that naming someone
 * Department head and giving them a department is enough, they become the head of that department when it has none.
 * Returns the department's name when it happened.
 */
async function linkHeadIfFree(user: { id: number; role_id: string; department_id: number | null; active: boolean }, replace = false): Promise<string | null> {
  if (!user.department_id || !user.active) return null;
  const { rows: role } = await db.query('SELECT permissions FROM roles WHERE id = $1', [user.role_id]);
  const perms = normalizePermissions(role[0]?.permissions);
  // Only a role that starts projects in its own department (the PMO and the company owner start them anywhere).
  if (!perms.includes('projects.create') || perms.includes('projects.edit_all') || perms.includes('projects.assign')) return null;
  // Replacing a head that is already there only when the admin asked for it (the "make head" box).
  const { rows } = await db.query(
    `UPDATE departments SET head_user_id = $1 OUTPUT INSERTED.name WHERE id = $2 AND (head_user_id IS NULL OR $3 = 1) AND (head_user_id IS NULL OR head_user_id <> $1)`,
    [user.id, user.department_id, replace],
  );
  return rows[0]?.name ?? null;
}

metaRouter.post(
  '/users',
  manage,
  route(async (req, res) => {
    const email = str(req.body?.email, 'Email', 200).toLowerCase();
    if (!isCompanyEmail(email)) throw new HttpError(400, `Use a ${COMPANY_DOMAIN} company email.`);
    const name = str(req.body?.name, 'Name', 120);
    const systemAdmin = req.body?.systemAdmin === true;
    if (systemAdmin && !isOwner(req.user!.email)) throw new HttpError(403, 'Only the owner can appoint a system admin.');
    // A system admin is a full PMO admin as well.
    const roleId = isOwner(email) || systemAdmin ? ADMIN_ROLE_ID : str(req.body?.roleId ?? 'member', 'Role', 60);
    if (!(await roleExists(roleId))) throw new HttpError(400, 'That role does not exist.');
    const exists = await db.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    if (exists.rows.length) throw new HttpError(409, 'Someone already uses that email.');
    const { user, inviteToken } = await db.tx(async (q) => {
      const { rows } = await q.query(
        `INSERT INTO users (email, name, role_id, title, department_id, must_set_password, created_by, is_system_admin)
         OUTPUT INSERTED.*
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
        [email, name, roleId, optStr(req.body?.title, 'Title', 120), optInt(req.body?.departmentId, 'Department'), req.user!.id, systemAdmin],
      );
      const invite = await issueInvite(q, rows[0].id, req.user!.id);
      return { user: { ...rows[0], invite_expires_at: invite.expires }, inviteToken: invite.token };
    });
    await logActivity(db, null, req.user!.id, 'user.created', { email, roleId, systemAdmin });
    const linkedHeadOf = await linkHeadIfFree(user, req.body?.makeHead === true);
    if (linkedHeadOf) await logActivity(db, null, req.user!.id, 'department.head_linked', { email, department: linkedHeadOf });
    await linkPeople();
    // The token goes back once, to the admin who sends the link. Only its hash is stored.
    res.status(201).json({ ...mapUser(user), inviteToken, linkedHeadOf });
  }),
);

/** A new setup link for an account that is not set up yet. The previous link stops working. */
metaRouter.post(
  '/users/:id/invite',
  manage,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const cur = await loadUser(id);
    assertCanTouch(req, cur);
    if (!cur.must_set_password && !cur.temp_password) throw new HttpError(400, 'This account is already set up. Use Reset password to send a new link.');
    if (!cur.active) throw new HttpError(400, 'Switch the account back on first.');
    // Still on an emailed temporary password: a link replaces it (the link works on an account with no password).
    if (cur.temp_password) {
      await db.query(
        'UPDATE users SET password_hash = NULL, must_set_password = 1, temp_password = 0, temp_password_expires_at = NULL, temp_password_sent_at = NULL WHERE id = $1',
        [id],
      );
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    }
    const invite = await issueInvite(db, id, req.user!.id);
    await logActivity(db, null, req.user!.id, 'user.invite_link', { email: cur.email });
    res.json({ ...mapUser({ ...cur, invite_expires_at: invite.expires }), inviteToken: invite.token });
  }),
);

metaRouter.patch(
  '/users/:id',
  manage,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const cur = await loadUser(id);
    const b = req.body ?? {};
    const owner = isOwner(cur.email);
    // Editing your own name or title is fine; everything else follows the rules.
    if (id !== req.user!.id) assertCanTouch(req, cur);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if ('name' in b) set('name', str(b.name, 'Name', 120));
    if ('title' in b) set('title', optStr(b.title, 'Title', 120));
    if ('departmentId' in b) set('department_id', optInt(b.departmentId, 'Department'));
    const nextAdmin: boolean = 'systemAdmin' in b ? b.systemAdmin === true : Boolean(cur.is_system_admin);
    if ('systemAdmin' in b && nextAdmin !== Boolean(cur.is_system_admin)) {
      if (!isOwner(req.user!.email)) throw new HttpError(403, 'Only the owner can appoint or remove a system admin.');
      if (owner) throw new HttpError(400, 'The owner is always a system admin.');
      set('is_system_admin', nextAdmin);
    }
    let nextRole: string = 'roleId' in b ? str(b.roleId, 'Role', 60) : cur.role_id;
    if (nextAdmin) nextRole = ADMIN_ROLE_ID;
    if (nextRole !== cur.role_id) {
      if (owner) throw new HttpError(400, 'The owner account always keeps the PMO admin role.');
      if (!(await roleExists(nextRole))) throw new HttpError(400, 'That role does not exist.');
      if (id === req.user!.id) throw new HttpError(400, 'You cannot change your own role.');
      set('role_id', nextRole);
    }
    const nextActive: boolean = 'active' in b ? Boolean(b.active) : cur.active;
    if ('active' in b && nextActive !== cur.active) {
      if (owner) throw new HttpError(400, 'The owner account cannot be switched off.');
      if (id === req.user!.id) throw new HttpError(400, 'You cannot switch off your own account.');
      set('active', nextActive);
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    const { rows } = await db.query(`UPDATE users SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE id = $1`, vals);
    if (!nextActive) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await logActivity(db, null, req.user!.id, 'user.updated', { email: cur.email, fields: Object.keys(b) });
    if ('name' in b || nextActive) await linkPeople();
    const linkedHeadOf = 'roleId' in b || 'departmentId' in b || b.makeHead === true ? await linkHeadIfFree(rows[0], b.makeHead === true) : null;
    if (linkedHeadOf) await logActivity(db, null, req.user!.id, 'department.head_linked', { email: cur.email, department: linkedHeadOf });
    res.json({ ...mapUser(rows[0]), linkedHeadOf });
  }),
);

/**
 * What deleting this person would touch: the projects they own and the departments they head (both block it:
 * those need a new owner first), and the open tasks given to them (those become unassigned).
 */
async function footprint(id: number) {
  const [p, d, t] = await Promise.all([
    db.query('SELECT id, code, name FROM projects WHERE manager_id = $1 ORDER BY code', [id]),
    db.query('SELECT id, name FROM departments WHERE head_user_id = $1 ORDER BY name', [id]),
    db.query(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = $1 AND status NOT IN ('done', 'cancelled')`, [id]),
  ]);
  return {
    projects: p.rows.map((r) => ({ id: r.id as number, code: r.code as string, name: r.name as string })),
    departments: d.rows.map((r) => ({ id: r.id as number, name: r.name as string })),
    openTasks: t.rows[0].n as number,
  };
}

metaRouter.get(
  '/users/:id/footprint',
  manage,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await loadUser(id);
    res.json(await footprint(id));
  }),
);

/**
 * Deletes an account for good. Never the owner and never yourself, and a system admin only by the owner. A person
 * who owns projects or heads a department cannot be deleted until those have someone else (deactivating keeps
 * everything and is the way to let someone go for now). Their sessions, notifications and team places go with
 * them. What they did stays in the history without their name, and their open tasks become unassigned (the
 * name written on the task stays, so a new account with that name picks them up again).
 */
metaRouter.delete(
  '/users/:id',
  manage,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const cur = await loadUser(id);
    if (id === req.user!.id) throw new HttpError(400, 'You cannot delete your own account.');
    if (isOwner(cur.email)) throw new HttpError(403, 'The owner account cannot be deleted.');
    assertCanTouch(req, cur);
    const f = await footprint(id);
    if (f.projects.length || f.departments.length) {
      const parts = [
        f.projects.length ? `owns ${f.projects.length} project${f.projects.length > 1 ? 's' : ''} (${f.projects.map((p) => p.code).join(', ')})` : '',
        f.departments.length ? `heads ${f.departments.length} department${f.departments.length > 1 ? 's' : ''} (${f.departments.map((d) => d.name).join(', ')})` : '',
      ].filter(Boolean);
      throw new HttpError(409, `${cur.name} ${parts.join(' and ')}. Give those to someone else first, or deactivate the account instead.`);
    }
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    await logActivity(db, null, req.user!.id, 'user.deleted', { email: cur.email, name: cur.name, roleId: cur.role_id, tasksUnassigned: f.openTasks });
    res.json({ ok: true });
  }),
);

/** Clears the password and signs the person out. They choose a new one through the setup link returned here. */
metaRouter.post(
  '/users/:id/reset-password',
  manage,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const cur = await loadUser(id);
    if (id === req.user!.id) throw new HttpError(400, 'Change your own password from your account menu.');
    assertCanTouch(req, cur);
    if (!cur.active) throw new HttpError(400, 'Switch the account back on first.');
    const invite = await db.tx(async (q) => {
      await q.query(
        'UPDATE users SET password_hash = NULL, must_set_password = 1, temp_password = 0, temp_password_expires_at = NULL, temp_password_sent_at = NULL WHERE id = $1',
        [id],
      );
      await q.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      return issueInvite(q, id, req.user!.id);
    });
    await logActivity(db, null, req.user!.id, 'user.password_reset', { email: cur.email });
    res.json({
      ...mapUser({ ...cur, password_hash: null, must_set_password: true, invite_expires_at: invite.expires }),
      inviteToken: invite.token,
    });
  }),
);

// ---- Mail check ---------------------------------------------------------------------------------
// Sends a test email to the admin's own address and says what the mail server answered, so a wrong password, a
// closed SMTP door or a typo can be told apart from the screen instead of from the server log.

metaRouter.post(
  '/mail/test',
  manage,
  route(async (req, res) => {
    if (!mailEnabled()) throw new HttpError(503, 'Mail is not set up: SMTP_HOST, SMTP_USER and SMTP_PASS are missing on the server.');
    try {
      await sendMail(
        req.user!.email,
        'SWiSH PMO: test email',
        'This is a test from SWiSH PMO. If you can read it, the system can email people their first password.',
        '<p>This is a test from <b>SWiSH PMO</b>. If you can read it, the system can email people their first password.</p>',
      );
    } catch (e) {
      // What the mail server said (never the password: the library does not echo it).
      const err = e as Error & { code?: string; responseCode?: number };
      throw new HttpError(502, `The mail server refused: ${[err.code, err.responseCode, err.message].filter(Boolean).join(' ')}. ${mailDiagnostics()}`);
    }
    res.json({ sentTo: req.user!.email });
  }),
);

// ---- Backup -----------------------------------------------------------------
// The whole database as one .sql file, for a copy that lives outside the server.
// Same people as account management: it holds every record in the system.

metaRouter.get(
  '/backup',
  manage,
  route(async (req, res) => {
    const { sql, counts } = await buildBackup();
    await logActivity(db, null, req.user!.id, 'backup.downloaded', { counts });
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="swish-pmo-backup-${todayIso()}.sql"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(sql);
  }),
);

/** When someone last downloaded a backup, so the page can nudge when it is old. */
metaRouter.get(
  '/backup/last',
  manage,
  route(async (_req, res) => {
    const { rows } = await db.query(
      `SELECT TOP (1) a.created_at, a.detail, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.action = 'backup.downloaded' ORDER BY a.created_at DESC`,
    );
    const r = rows[0];
    const detail = typeof r?.detail === 'string' ? JSON.parse(r.detail) : r?.detail;
    res.json(r ? { at: new Date(r.created_at).toISOString(), by: r.name ?? null, counts: detail?.counts ?? null } : null);
  }),
);

// ---- Roles (users.manage) -----------------------------------------------------

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'role'
  );
}

function permissionsFrom(req: Request) {
  const list = normalizePermissions(req.body?.permissions);
  if (!Array.isArray(req.body?.permissions)) throw new HttpError(400, 'Permissions must be a list.');
  return list.filter((p) => PERMISSION_KEYS.includes(p));
}

metaRouter.post(
  '/roles',
  manage,
  route(async (req, res) => {
    const name = str(req.body?.name, 'Role name', 60);
    let id = slug(name);
    const { rows: taken } = await db.query('SELECT id FROM roles WHERE id LIKE $1', [`${id}%`]);
    if (taken.some((r) => r.id === id)) id = `${id}-${taken.length + 1}`;
    const { rows } = await db.query(
      'INSERT INTO roles (id, name, name_ar, permissions) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4)',
      [id, name, optStr(req.body?.nameAr, 'Arabic name', 60) ?? '', JSON.stringify(permissionsFrom(req))],
    );
    await logActivity(db, null, req.user!.id, 'role.created', { id, name });
    res.status(201).json(mapRole(rows[0]));
  }),
);

metaRouter.patch(
  '/roles/:id',
  manage,
  route(async (req, res) => {
    const id = String(req.params.id);
    const { rows: cur } = await db.query('SELECT * FROM roles WHERE id = $1', [id]);
    if (!cur[0]) throw new HttpError(404, 'Role not found.');
    if (cur[0].protected) throw new HttpError(400, 'The PMO admin role always has every permission.');
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if ('name' in (req.body ?? {})) set('name', str(req.body.name, 'Role name', 60));
    if ('nameAr' in (req.body ?? {})) set('name_ar', optStr(req.body.nameAr, 'Arabic name', 60) ?? '');
    if ('permissions' in (req.body ?? {})) {
      set('permissions', JSON.stringify(permissionsFrom(req)));
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    const { rows } = await db.query(`UPDATE roles SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE id = $1`, vals);
    await logActivity(db, null, req.user!.id, 'role.updated', { id });
    res.json(mapRole(rows[0]));
  }),
);

metaRouter.delete(
  '/roles/:id',
  manage,
  route(async (req, res) => {
    const id = String(req.params.id);
    const { rows: cur } = await db.query('SELECT protected FROM roles WHERE id = $1', [id]);
    if (!cur[0]) throw new HttpError(404, 'Role not found.');
    if (cur[0].protected) throw new HttpError(400, 'The PMO admin role cannot be removed.');
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM users WHERE role_id = $1', [id]);
    if (rows[0].n > 0) throw new HttpError(400, `Move the ${rows[0].n} people on this role to another role first.`);
    await db.query('DELETE FROM roles WHERE id = $1', [id]);
    await logActivity(db, null, req.user!.id, 'role.deleted', { id });
    res.json({ ok: true });
  }),
);

// ---- Directory: every name the plans mention --------------------------------------

metaRouter.get(
  '/directory',
  manage,
  route(async (_req, res) => {
    res.json(await directory(todayIso()));
  }),
);

/** Two spellings of one person become one name everywhere. */
metaRouter.post(
  '/directory/merge',
  manage,
  route(async (req, res) => {
    const from = str(req.body?.from, 'Name to merge', 200);
    const to = str(req.body?.to, 'Name to keep', 200);
    if (from === to) throw new HttpError(400, 'Pick two different names.');
    const changed = await db.tx(async (q) => {
      const n = await mergeName(q, from, to);
      await linkPeople(q);
      return n;
    });
    await logActivity(db, null, req.user!.id, 'directory.merged', { from, to, changed });
    res.json({ changed, directory: await directory(todayIso()) });
  }),
);

/**
 * The head of a department: an account (chosen from the people list), whose name is then also the text the
 * tracker's page showed. A name typed without an account keeps working as plain text.
 */
async function resolveHead(b: any, currentName: string | null): Promise<{ headUserId: number | null; headName: string | null }> {
  if (b?.headUserId !== undefined && b.headUserId !== null && b.headUserId !== '') {
    const id = Number(b.headUserId);
    const { rows } = await db.query('SELECT id, name FROM users WHERE id = $1 AND active = 1', [id]);
    if (!rows[0]) throw new HttpError(400, 'That account does not exist or is switched off.');
    return { headUserId: id, headName: rows[0].name };
  }
  if ('headUserId' in (b ?? {})) return { headUserId: null, headName: optStr(b.headName, 'Head', 120) ?? currentName };
  return { headUserId: null, headName: optStr(b?.headName, 'Head', 120) };
}

metaRouter.post(
  '/departments',
  manage,
  route(async (req, res) => {
    const name = str(req.body?.name, 'Name', 80);
    const code = str(req.body?.code, 'Code', 12).toUpperCase();
    const { headUserId, headName } = await resolveHead(req.body, null);
    const { rows: slotRows } = await db.query('SELECT COUNT(*) AS n FROM departments');
    const { rows } = await db.query(
      'INSERT INTO departments (code, name, name_ar, color_slot, head_name, head_user_id) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6)',
      [code, name, optStr(req.body?.nameAr, 'Arabic name', 80) ?? '', (slotRows[0].n % 8) + 1, headName, headUserId],
    );
    await logActivity(db, null, req.user!.id, 'department.created', { code, name });
    res.status(201).json(mapDepartment(rows[0]));
  }),
);

/** Rename a department, give it an Arabic name, or name its head. The code and colour stay. */
metaRouter.patch(
  '/departments/:id',
  manage,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const { rows: cur } = await db.query('SELECT * FROM departments WHERE id = $1', [id]);
    if (!cur[0]) throw new HttpError(404, 'Department not found.');
    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if ('name' in b) set('name', str(b.name, 'Name', 80));
    if ('nameAr' in b) set('name_ar', optStr(b.nameAr, 'Arabic name', 80) ?? '');
    if ('headUserId' in b || 'headName' in b) {
      const { headUserId, headName } = await resolveHead(b, cur[0].head_name);
      if ('headUserId' in b) set('head_user_id', headUserId);
      set('head_name', headName);
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    const { rows } = await db.query(`UPDATE departments SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE id = $1`, vals);
    await logActivity(db, null, req.user!.id, 'department.updated', {
      code: cur[0].code,
      from: { name: cur[0].name, nameAr: cur[0].name_ar, head: cur[0].head_name },
      to: { name: rows[0].name, nameAr: rows[0].name_ar, head: rows[0].head_name },
      ...(cur[0].head_user_id !== rows[0].head_user_id ? { headAccountFrom: cur[0].head_user_id, headAccountTo: rows[0].head_user_id } : {}),
    });
    res.json(mapDepartment(rows[0]));
  }),
);

// ---- Working calendar -------------------------------------------------------------
// Official holidays, kept by the owner and system admins. Friday and Saturday need no rows.
// A holiday of several days (Eid) is added as a range and stored one row a day.

metaRouter.post(
  '/holidays',
  manage,
  route(async (req, res) => {
    const from = date(req.body?.from, 'The first day');
    const to = req.body?.to ? date(req.body.to, 'The last day') : from;
    if (to < from) throw new HttpError(400, 'The last day is before the first.');
    const days = diffDays(from, to) + 1;
    if (days > 31) throw new HttpError(400, 'A holiday can run 31 days at most.');
    const name = str(req.body?.name, 'Name', 80).trim();
    const nameAr = optStr(req.body?.nameAr, 'Arabic name', 80) ?? '';
    await db.tx(async (q) => {
      for (let i = 0; i < days; i++) {
        await q.query(
          `UPDATE holidays SET name = $2, name_ar = $3 WHERE [day] = $1;
           IF @@ROWCOUNT = 0 INSERT INTO holidays ([day], name, name_ar, created_by) VALUES ($1, $2, $3, $4)`,
          [addDays(from, i), name, nameAr, req.user!.id],
        );
      }
      await logActivity(q, null, req.user!.id, 'holiday.added', { name, from, to });
    });
    res.status(201).json(await loadHolidays(db));
  }),
);

/** Remove some days (a whole holiday is its days). */
metaRouter.post(
  '/holidays/remove',
  manage,
  route(async (req, res) => {
    const list: unknown[] = Array.isArray(req.body?.days) ? req.body.days.slice(0, 62) : [];
    const days = list.map((d) => date(d, 'Day'));
    if (!days.length) throw new HttpError(400, 'Pick the days to remove.');
    const { rows } = await db.query('DELETE FROM holidays OUTPUT DELETED.* WHERE [day] IN (SELECT CAST(value AS DATE) FROM OPENJSON($1))', [days]);
    if (rows.length) {
      const sorted = rows.map((r) => r.day as string).sort();
      await logActivity(db, null, req.user!.id, 'holiday.removed', { name: rows[0].name, from: sorted[0], to: sorted[sorted.length - 1] });
    }
    res.json(await loadHolidays(db));
  }),
);

// ---- Activity log ---------------------------------------------------------------
// Every create, change and decision the system records, for the owner and system admins.

metaRouter.get(
  '/audit',
  manage,
  route(async (req, res) => {
    const q = req.query;
    const page = Math.max(1, Number(q.page) || 1);
    const size = 50;
    const where: string[] = [];
    const vals: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      vals.push(v);
      where.push(sql.replace('?', `$${vals.length}`));
    };
    if (typeof q.group === 'string' && /^[a-z_]+$/.test(q.group)) add('a.action LIKE ?', `${q.group}.%`);
    if (typeof q.user === 'string' && /^\d+$/.test(q.user)) add('a.user_id = ?', Number(q.user));
    if (typeof q.project === 'string' && /^\d+$/.test(q.project)) add('a.project_id = ?', Number(q.project));
    if (typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) add("a.created_at >= TODATETIMEOFFSET(CAST(CAST(? AS DATE) AS DATETIME2), '+03:00')", q.from);
    if (typeof q.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) add("a.created_at < TODATETIMEOFFSET(DATEADD(DAY, 1, CAST(CAST(? AS DATE) AS DATETIME2)), '+03:00')", q.to);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.query(`SELECT COUNT(*) AS n FROM activity a ${w}`, vals)).rows[0].n;
    const { rows } = await db.query(
      `SELECT a.id, a.action, a.detail, a.created_at, a.user_id, a.project_id, u.name AS user_name, p.code AS project_code
         FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN projects p ON p.id = a.project_id
         ${w} ORDER BY a.created_at DESC, a.id DESC OFFSET ${(page - 1) * size} ROWS FETCH NEXT ${size} ROWS ONLY`,
      vals,
    );
    const groups = (await db.query("SELECT DISTINCT LEFT(action, CHARINDEX('.', action + '.') - 1) AS g FROM activity ORDER BY 1")).rows.map((r) => r.g);
    res.json({
      total,
      page,
      pages: Math.max(1, Math.ceil(total / size)),
      groups,
      rows: rows.map((r) => ({
        id: r.id,
        action: r.action,
        detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
        at: new Date(r.created_at).toISOString(),
        userId: r.user_id,
        userName: r.user_name,
        projectId: r.project_id,
        projectCode: r.project_code,
      })),
    });
  }),
);
