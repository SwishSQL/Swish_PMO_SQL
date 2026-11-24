import { Router } from 'express';
import type { Request } from 'express';
import { db } from '../db';
import { HttpError, can, canManageAccounts, route } from '../auth';
import { idParam, optInt, optStr, str } from '../validate';
import { logActivity } from '../service';
import { LEADS_PROJECTS } from '../../shared/permissions';
import type { StaffMember } from '../../shared/types';
import { syncAccountFromStaff } from '../orgSync';

// The staff directory: everyone in the company, with their department, position and direct manager, whether or not
// they have an account. It is the org chart the PMO and the assistant refer to (who heads what, who reports to whom).
// Kept here: system admins edit it; an account is linked to its person by email.

export const staffRouter = Router();

const SELECT = `
  SELECT s.*, u.id AS user_id
    FROM staff s
    OUTER APPLY (SELECT TOP (1) id FROM users WHERE s.email IS NOT NULL AND LOWER(email) = LOWER(s.email) ORDER BY id) u`;

export function mapStaff(r: any): StaffMember {
  return {
    id: r.id,
    empNo: r.emp_no,
    name: r.name,
    email: r.email,
    departmentId: r.department_id,
    position: r.position,
    managerId: r.manager_id,
    userId: r.user_id ?? null,
    active: r.active,
    boardTitle: r.board_title ?? null,
    boardRank: r.board_rank ?? null,
  };
}

/** The PMO and the system admins read the org chart. */
function mayRead(req: Request): boolean {
  return canManageAccounts(req) || can(req, 'projects.edit_all');
}

staffRouter.get(
  '/staff',
  route(async (req, res) => {
    if (!mayRead(req)) throw new HttpError(403, 'The org chart is for the PMO and the system admins.');
    const { rows } = await db.query(`${SELECT} ORDER BY s.name`);
    res.json(rows.map(mapStaff));
  }),
);

/**
 * For whoever gives work (asking for someone new): the people without an account yet, to fill in a name, email and
 * department. Not the org chart itself.
 */
staffRouter.get(
  '/staff/lookup',
  route(async (req, res) => {
    if (!mayRead(req) && !LEADS_PROJECTS.some((p) => can(req, p))) throw new HttpError(403, 'Only whoever gives work looks people up.');
    const { rows } = await db.query(`${SELECT} WHERE s.active = 1 ORDER BY s.name`);
    res.json(rows.filter((r) => !r.user_id).map((r) => ({ id: r.id, name: r.name, email: r.email, departmentId: r.department_id, position: r.position })));
  }),
);

async function assertNoLoop(id: number | null, managerId: number | null): Promise<void> {
  if (!managerId) return;
  if (id && managerId === id) throw new HttpError(400, 'Someone cannot report to themselves.');
  let at: number | null = managerId;
  for (let i = 0; at && i < 50; i++) {
    if (id && at === id) throw new HttpError(400, 'That manager reports, directly or not, to this person.');
    const found: { rows: { manager_id: number | null }[] } = await db.query('SELECT manager_id FROM staff WHERE id = $1', [at]);
    if (!found.rows[0]) throw new HttpError(400, 'That manager is not in the directory.');
    at = found.rows[0].manager_id;
  }
}

function fields(b: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || 'name' in b) out.name = str(b.name, 'Name', 160);
  if ('email' in b) {
    const e = optStr(b.email, 'Email', 200);
    out.email = e ? e.toLowerCase() : null;
  }
  if ('departmentId' in b) out.department_id = optInt(b.departmentId, 'Department');
  if ('position' in b) out.position = optStr(b.position, 'Position', 160);
  if ('managerId' in b) out.manager_id = optInt(b.managerId, 'Manager');
  if ('empNo' in b) out.emp_no = optStr(b.empNo, 'Employee number', 40);
  if ('active' in b) out.active = b.active !== false;
  if ('boardTitle' in b) out.board_title = optStr(b.boardTitle, 'Board title', 120);
  if ('boardRank' in b) out.board_rank = optInt(b.boardRank, 'Board order');
  return out;
}

staffRouter.post(
  '/staff',
  route(async (req, res) => {
    if (!canManageAccounts(req)) throw new HttpError(403, 'System admins keep the staff directory.');
    const f = fields(req.body ?? {}, false);
    await assertNoLoop(null, (f.manager_id as number | null) ?? null);
    const cols = Object.keys(f);
    const { rows } = await db.query(
      `INSERT INTO staff (${cols.join(', ')}) OUTPUT INSERTED.id VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => f[c]),
    );
    await logActivity(db, null, req.user!.id, 'staff.added', { name: f.name });
    await syncAccountFromStaff(db, rows[0].id);
    const { rows: out } = await db.query(`${SELECT} WHERE s.id = $1`, [rows[0].id]);
    res.status(201).json(mapStaff(out[0]));
  }),
);

staffRouter.patch(
  '/staff/:id',
  route(async (req, res) => {
    if (!canManageAccounts(req)) throw new HttpError(403, 'System admins keep the staff directory.');
    const id = idParam(req.params.id);
    const f = fields(req.body ?? {}, true);
    if ('manager_id' in f) await assertNoLoop(id, f.manager_id as number | null);
    const cols = Object.keys(f);
    const { rows: there } = await db.query('SELECT 1 FROM staff WHERE id = $1', [id]);
    if (!there.length) throw new HttpError(404, 'Not in the directory.');
    if (cols.length) {
      await db.query(`UPDATE staff SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = SYSDATETIMEOFFSET() WHERE id = $1`, [id, ...cols.map((c) => f[c])]);
      await logActivity(db, null, req.user!.id, 'staff.changed', { id, fields: cols });
      // The account of the same person follows the org chart.
      const synced = await syncAccountFromStaff(db, id);
      if (synced.length) await logActivity(db, null, req.user!.id, 'user.synced_from_org', { id, fields: synced });
    }
    const { rows: out } = await db.query(`${SELECT} WHERE s.id = $1`, [id]);
    res.json(mapStaff(out[0]));
  }),
);

/** Department heads and, for the names given, each person's department, position and line of managers. */
export async function orgContext(names: string[]): Promise<{ heads: { department: string; head: string | null }[]; people: { name: string; department: string | null; position: string | null; reportsTo: string[] }[] }> {
  const { rows: depts } = await db.query(`SELECT d.name, u.name AS head FROM departments d LEFT JOIN users u ON u.id = d.head_user_id ORDER BY d.name`);
  const { rows: staff } = await db.query(`SELECT s.id, s.name, s.position, s.manager_id, d.name AS dept FROM staff s LEFT JOIN departments d ON d.id = s.department_id WHERE s.active = 1`);
  const byId = new Map(staff.map((s) => [s.id, s]));
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const people: { name: string; department: string | null; position: string | null; reportsTo: string[] }[] = [];
  const seen = new Set<number>();
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    const exact = staff.filter((s) => norm(s.name) === n);
    const hits = exact.length ? exact : staff.filter((s) => norm(s.name).split(' ')[0] === n.split(' ')[0] && n.split(' ').every((t) => norm(s.name).includes(t)));
    if (hits.length !== 1 || seen.has(hits[0].id)) continue;
    const s = hits[0];
    seen.add(s.id);
    const chain: string[] = [];
    for (let m = byId.get(s.manager_id); m && chain.length < 4; m = byId.get(m.manager_id)) chain.push(m.name);
    people.push({ name: s.name, department: s.dept, position: s.position, reportsTo: chain });
  }
  return { heads: depts.map((d) => ({ department: d.name, head: d.head })), people };
}
