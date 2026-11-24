import { Router } from 'express';
import type { Request } from 'express';
import { db } from '../db';
import { HttpError, can, canGovernProject, canManageAccounts, isOwner, issueInvite, route } from '../auth';
import { idParam, optInt, optStr, str } from '../validate';
import { logActivity } from '../service';
import { notify } from '../notify';
import { isCompanyEmail, COMPANY_DOMAIN } from '../../shared/permissions';
import type { OwnerRequest } from '../../shared/types';

// Giving work across departments. A project manager gives milestones to people of the project's own department
// directly. For anyone else they ask: the other department (its head picks the person), a named person of another
// department (their head approves), or someone without an account yet (a system admin creates it). The milestone
// waits, unassigned, until the request is decided. A department without a head falls back to the PMO.

export const ownersRouter = Router();

const SELECT = `
  SELECT r.*, t.name AS task_name, t.project_id, p.code AS project_code, p.name AS project_name,
         d.name AS department_name, d.head_user_id, u.name AS user_name, rb.name AS requested_by_name
    FROM owner_requests r
    JOIN tasks t ON t.id = r.task_id
    JOIN projects p ON p.id = t.project_id
    JOIN departments d ON d.id = r.department_id
    LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN users rb ON rb.id = r.requested_by`;

function mapRequest(r: any): OwnerRequest {
  return {
    id: r.id,
    taskId: r.task_id,
    taskName: r.task_name,
    projectId: r.project_id,
    projectCode: r.project_code,
    projectName: r.project_name,
    departmentId: r.department_id,
    departmentName: r.department_name,
    kind: r.new_email ? 'new' : r.user_id ? 'person' : 'department',
    userId: r.user_id,
    userName: r.user_name ?? r.new_name ?? null,
    newEmail: r.new_email,
    requestedBy: r.requested_by_name,
    requestedAt: r.requested_at instanceof Date ? r.requested_at.toISOString() : String(r.requested_at),
    status: r.status,
    note: r.note,
  };
}

/** Who decides a request: a new account is for the system admins; the rest for the department's head (or the PMO). */
function decides(req: Request, r: any): boolean {
  if (r.new_email) return canManageAccounts(req);
  return r.head_user_id === req.user!.id || (!r.head_user_id && can(req, 'projects.edit_all'));
}

async function deciders(r: { new_email: string | null; head_user_id: number | null }): Promise<number[]> {
  if (!r.new_email && r.head_user_id) return [r.head_user_id];
  const { rows } = r.new_email
    ? await db.query(`SELECT id, email, is_system_admin FROM users WHERE active = 1`).then((x) => ({ rows: x.rows.filter((u) => u.is_system_admin || isOwner(u.email)) }))
    : await db.query(`SELECT u.id FROM users u JOIN roles ro ON ro.id = u.role_id WHERE u.active = 1 AND EXISTS (SELECT 1 FROM OPENJSON(ro.permissions) WHERE value = 'projects.edit_all')`);
  return rows.map((x) => x.id);
}

/** Pending requests of a project, for its plan (a milestone shows who it waits for). */
ownersRouter.get(
  '/projects/:id/owner-requests',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const { rows } = await db.query(`${SELECT} WHERE t.project_id = $1 AND r.status = 'pending' ORDER BY r.requested_at`, [id]);
    res.json(rows.map(mapRequest));
  }),
);

/** Ask for an owner from outside the project's department. */
ownersRouter.post(
  '/tasks/:taskId/owner-request',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const { rows: tr } = await db.query('SELECT t.*, p.department_id AS project_dept, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1', [taskId]);
    const task = tr[0];
    if (!task) throw new HttpError(404, 'Task not found.');
    if (!(await canGovernProject(req, task.project_id))) throw new HttpError(403, 'Only the project manager gives work in this project.');
    if (task.kind === 'summary' || task.system_key) throw new HttpError(400, 'Phases and the closure documents milestone have no owner to ask for.');
    const b = req.body ?? {};
    let departmentId = optInt(b.departmentId, 'Department');
    const userId = optInt(b.userId, 'Person');
    let newName: string | null = null;
    let newEmail: string | null = null;
    if (b.newEmail !== undefined && b.newEmail !== null && b.newEmail !== '') {
      newEmail = str(b.newEmail, 'Email', 200).toLowerCase();
      newName = str(b.newName, 'Name', 120);
      if (!isCompanyEmail(newEmail)) throw new HttpError(400, `Use a ${COMPANY_DOMAIN} company email.`);
      const { rows: ex } = await db.query('SELECT name FROM users WHERE LOWER(email) = $1', [newEmail]);
      if (ex.length) throw new HttpError(409, `${ex[0].name} already has an account: choose them from the list.`);
      if (!departmentId) throw new HttpError(400, 'Choose the department of the new person.');
    } else if (userId) {
      const { rows: ur } = await db.query('SELECT department_id, active FROM users WHERE id = $1', [userId]);
      if (!ur[0]?.active) throw new HttpError(400, 'That person is not active.');
      if (!ur[0].department_id) throw new HttpError(400, 'That person has no department yet: ask the PMO to set it.');
      departmentId = ur[0].department_id;
      if (departmentId === task.project_dept) throw new HttpError(400, 'Same department as the project: give it to them directly.');
    } else if (!departmentId) {
      throw new HttpError(400, 'Choose a department, a person, or someone new.');
    }
    const { rows: dr } = await db.query('SELECT id, name, head_user_id FROM departments WHERE id = $1', [departmentId]);
    if (!dr[0]) throw new HttpError(400, 'That department does not exist.');
    const created = await db.tx(async (q) => {
      // One open request per milestone: a new one replaces it.
      await q.query(`UPDATE owner_requests SET status = 'cancelled', decided_by = $2, decided_at = SYSDATETIMEOFFSET() WHERE task_id = $1 AND status = 'pending'`, [taskId, req.user!.id]);
      const { rows } = await q.query(
        `INSERT INTO owner_requests (task_id, department_id, user_id, new_name, new_email, requested_by, note)
         OUTPUT INSERTED.id
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [taskId, departmentId, newEmail ? null : userId, newName, newEmail, req.user!.id, optStr(b.note, 'Note', 500)],
      );
      // Until it is decided, the milestone has no owner (the name asked for shows as waiting).
      await q.query('UPDATE tasks SET assignee_id = NULL WHERE id = $1', [taskId]);
      await logActivity(q, task.project_id, req.user!.id, 'owner.requested', { taskId, name: task.name, departmentId, userId, newEmail });
      return rows[0].id as number;
    });
    const { rows: out } = await db.query(`${SELECT} WHERE r.id = $1`, [created]);
    await notify(db, await deciders(out[0]), { kind: 'owner.requested', projectId: task.project_id, taskId, data: { name: task.name, project: task.project_name, by: req.user!.name } }, req.user!.id);
    res.status(201).json(mapRequest(out[0]));
  }),
);

/** Withdraw a pending request (the project manager). */
ownersRouter.delete(
  '/owner-requests/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const { rows } = await db.query(`${SELECT} WHERE r.id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, 'Request not found.');
    if (!(await canGovernProject(req, rows[0].project_id))) throw new HttpError(403, 'Only the project manager withdraws it.');
    await db.query(`UPDATE owner_requests SET status = 'cancelled', decided_by = $2, decided_at = SYSDATETIMEOFFSET() WHERE id = $1 AND status = 'pending'`, [id, req.user!.id]);
    res.json({ ok: true });
  }),
);

/** What waits for this person's decision, with the people they may pick. */
ownersRouter.get(
  '/owner-requests/inbox',
  route(async (req, res) => {
    const { rows } = await db.query(`${SELECT} WHERE r.status = 'pending' ORDER BY r.requested_at`);
    const mine = rows.filter((r) => decides(req, r));
    const depts = [...new Set(mine.filter((r) => !r.new_email).map((r) => r.department_id))];
    const { rows: people } = depts.length
      ? await db.query('SELECT id, name, department_id FROM users WHERE active = 1 AND department_id IN (SELECT CAST(value AS INT) FROM OPENJSON($1)) ORDER BY name', [depts])
      : { rows: [] as any[] };
    res.json(
      mine.map((r) => ({
        ...mapRequest(r),
        candidates: r.new_email ? [] : people.filter((u) => u.department_id === r.department_id).map((u) => ({ id: u.id, name: u.name })),
      })),
    );
  }),
);

/** Decide: approve (with the person, for a department request or another pick), or decline. */
ownersRouter.post(
  '/owner-requests/:id/decide',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const { rows } = await db.query(`${SELECT} WHERE r.id = $1`, [id]);
    const r = rows[0];
    if (!r) throw new HttpError(404, 'Request not found.');
    if (r.status !== 'pending') throw new HttpError(409, 'This request was already decided.');
    if (!decides(req, r)) throw new HttpError(403, r.new_email ? 'A system admin creates new accounts.' : 'The head of that department decides.');
    const approve = req.body?.decision === 'approve';
    const note = optStr(req.body?.note, 'Note', 500);
    let assignee: { id: number; name: string } | null = null;
    await db.tx(async (q) => {
      if (approve) {
        if (r.new_email) {
          const { rows: ex } = await q.query('SELECT id, name FROM users WHERE LOWER(email) = $1', [r.new_email]);
          if (ex[0]) assignee = ex[0];
          else {
            // Made like any account before launch: the setup email waits for the Users page.
            const { rows: nu } = await q.query(
              `INSERT INTO users (email, name, role_id, department_id, must_set_password, created_by) OUTPUT INSERTED.id, INSERTED.name VALUES ($1, $2, 'member', $3, 1, $4)`,
              [r.new_email, r.new_name, r.department_id, req.user!.id],
            );
            await issueInvite(q, nu[0].id, req.user!.id);
            await logActivity(q, null, req.user!.id, 'user.created', { email: r.new_email, roleId: 'member', held: true, fromRequest: id });
            assignee = nu[0];
          }
        } else {
          const pick = optInt(req.body?.userId, 'Person') ?? r.user_id;
          if (!pick) throw new HttpError(400, 'Choose the person from your team.');
          const { rows: ur } = await q.query('SELECT id, name, department_id, active FROM users WHERE id = $1', [pick]);
          if (!ur[0]?.active || ur[0].department_id !== r.department_id) throw new HttpError(400, `Choose someone of ${r.department_name}.`);
          assignee = { id: ur[0].id, name: ur[0].name };
        }
        const a = assignee as unknown as { id: number; name: string };
        await q.query('UPDATE tasks SET assignee_id = $2, owner_name = $3 WHERE id = $1', [r.task_id, a.id, a.name]);
      }
      await q.query(`UPDATE owner_requests SET status = $2, decided_by = $3, decided_at = SYSDATETIMEOFFSET(), note = COALESCE($4, note) WHERE id = $1`, [id, approve ? 'approved' : 'declined', req.user!.id, note]);
      await logActivity(q, r.project_id, req.user!.id, approve ? 'owner.approved' : 'owner.declined', { taskId: r.task_id, name: r.task_name, to: (assignee as any)?.name ?? null });
    });
    const a = assignee as { id: number; name: string } | null;
    await notify(db, [r.requested_by], { kind: 'owner.decided', projectId: r.project_id, taskId: r.task_id, data: { name: r.task_name, by: req.user!.name, decision: approve ? 'approve' : 'decline', to: a?.name ?? null } }, req.user!.id);
    if (a) await notify(db, [a.id], { kind: 'task.assigned', projectId: r.project_id, taskId: r.task_id, data: { name: r.task_name, by: req.user!.name } }, req.user!.id);
    res.json({ ok: true, assigneeId: a?.id ?? null });
  }),
);
