import type { Queryable } from './db';
import { HttpError } from './auth';
import { date, optStr, str } from './validate';
import { pushSuccessors } from './plan';
import { resync } from './service';
import { normalizePermissions } from '../shared/permissions';
import type { ChangeArea, ChangeRequest, ProposedChanges } from '../shared/types';

// Change requests: the formal change process. A change to the scope, cost or schedule of a project is written on
// a change request (what, why, the actions it takes), approved by the head of the project's department and then by
// the PMO, and only then applied: the system applies it itself, so nothing changes before the approvals. Every
// request stays in the project's change log, with its outcome.

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export function mapChange(r: any): ChangeRequest {
  const changes = (typeof r.changes === 'string' ? JSON.parse(r.changes) : r.changes) ?? {};
  const snapshot = (typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot) ?? {};
  const areas = (typeof r.areas === 'string' ? JSON.parse(r.areas) : r.areas) ?? [];
  const applied = typeof r.applied === 'string' ? JSON.parse(r.applied) : (r.applied ?? null);
  return {
    id: r.id,
    projectId: r.project_id,
    code: `CR-${String(r.seq).padStart(3, '0')}`,
    requestedBy: r.requested_by ?? null,
    requestedByName: r.requested_by_name ?? null,
    requestedAt: iso(r.requested_at) as string,
    areas,
    description: r.description,
    reason: r.reason,
    actions: r.actions ?? '',
    actionsDate: r.actions_date ?? null,
    changes,
    before: snapshot,
    status: r.status,
    stage: r.stage,
    headBy: r.head_by ?? null,
    headByName: r.head_by_name ?? null,
    headAt: iso(r.head_at),
    headNote: r.head_note ?? null,
    headSkipped: r.head_skipped ?? null,
    decidedBy: r.decided_by ?? null,
    decidedByName: r.decided_by_name ?? null,
    decidedAt: iso(r.decided_at),
    decisionNote: r.decision_note ?? null,
    applied,
    progress: r.progress ?? '',
    completionDate: r.completion_date ?? null,
    notes: r.notes ?? '',
  };
}

export const CHANGE_SELECT = `SELECT c.*, rq.name AS requested_by_name, hb.name AS head_by_name, dc.name AS decided_by_name
  FROM change_requests c
  LEFT JOIN users rq ON rq.id = c.requested_by
  LEFT JOIN users hb ON hb.id = c.head_by
  LEFT JOIN users dc ON dc.id = c.decided_by`;

export async function loadChange(q: Queryable, id: number): Promise<ChangeRequest | null> {
  const { rows } = await q.query(`${CHANGE_SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ? mapChange(rows[0]) : null;
}

/**
 * What a request proposes, checked against the project: only real changes are kept (a value equal to today's is
 * dropped), milestones must be the project's, new ones go inside a phase that is required. Returns the clean
 * changes, the values they replace, and the areas they touch.
 */
export async function cleanChanges(q: Queryable, projectId: number, raw: any): Promise<{ changes: ProposedChanges; snapshot: ChangeRequest['before']; areas: ChangeArea[] }> {
  const { rows: pr } = await q.query('SELECT start_date, end_date, budget, scope, objective FROM projects WHERE id = $1', [projectId]);
  const p = pr[0];
  if (!p) throw new HttpError(404, 'Project not found.');
  const changes: ProposedChanges = {};
  const snapshot: ChangeRequest['before'] = {};
  const areas = new Set<ChangeArea>();
  const given = (k: string) => raw && raw[k] !== undefined && raw[k] !== '';

  if (given('startDate')) {
    const v = date(raw.startDate, 'New start date');
    if (v !== p.start_date) ((changes.startDate = v), (snapshot.startDate = p.start_date), areas.add('schedule'));
  }
  if (given('endDate')) {
    const v = date(raw.endDate, 'New end date');
    if (v !== p.end_date) ((changes.endDate = v), (snapshot.endDate = p.end_date), areas.add('schedule'));
  }
  if ((changes.startDate ?? p.start_date) > (changes.endDate ?? p.end_date)) throw new HttpError(400, 'The new end date is before the start.');
  if (raw && 'budget' in raw && raw.budget !== undefined) {
    const v = raw.budget === '' || raw.budget === null ? null : Number(raw.budget);
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw new HttpError(400, 'The new budget must be a positive number.');
    const cur = p.budget === null || p.budget === undefined ? null : Number(p.budget);
    if (v !== cur) ((changes.budget = v), (snapshot.budget = cur), areas.add('cost'));
  }
  for (const k of ['scope', 'objective'] as const) {
    if (raw && typeof raw[k] === 'string') {
      const v = (optStr(raw[k], k === 'scope' ? 'Scope' : 'Objective', 4000) ?? '').trim();
      if (v !== (p[k] ?? '').trim()) ((changes[k] = v), (snapshot[k] = p[k] ?? null), areas.add('scope'));
    }
  }

  const moves = Array.isArray(raw?.milestones) ? raw.milestones : [];
  if (moves.length > 100) throw new HttpError(400, 'At most 100 milestones in one request.');
  if (moves.length) {
    const ids = moves.map((m: any) => Number(m?.taskId));
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'A milestone appears twice in the request.');
    const { rows } = await q.query(`SELECT id, name, end_date, status FROM tasks WHERE project_id = $1 AND kind = 'milestone' AND id IN (SELECT CAST(value AS INT) FROM OPENJSON($2))`, [projectId, ids]);
    const byId = new Map(rows.map((r) => [r.id as number, r]));
    changes.milestones = [];
    snapshot.milestones = [];
    for (const m of moves) {
      const t = byId.get(Number(m?.taskId));
      if (!t) throw new HttpError(400, 'A milestone in the request is not in this project.');
      if (m.action === 'cancel') {
        if (t.status === 'cancelled') continue;
        changes.milestones.push({ taskId: t.id, action: 'cancel' });
        areas.add('scope');
      } else {
        const to = date(m.to, `New date for "${t.name}"`);
        if (to === t.end_date) continue;
        changes.milestones.push({ taskId: t.id, action: 'move', to });
        areas.add('schedule');
      }
      snapshot.milestones.push({ taskId: t.id, name: t.name, date: t.end_date });
    }
    if (!changes.milestones.length) delete changes.milestones;
    if (!snapshot.milestones.length) delete snapshot.milestones;
  }

  const added = Array.isArray(raw?.newMilestones) ? raw.newMilestones : [];
  if (added.length > 50) throw new HttpError(400, 'At most 50 new milestones in one request.');
  if (added.length) {
    changes.newMilestones = [];
    for (const m of added) {
      const name = str(m?.name, 'New milestone name', 160).trim();
      const d = date(m?.date, `Date for "${name}"`);
      let parentId: number | null = m?.parentId ? Number(m.parentId) : null;
      if (parentId) {
        const { rows } = await q.query(`SELECT kind, not_required FROM tasks WHERE id = $1 AND project_id = $2`, [parentId, projectId]);
        if (!rows[0] || rows[0].kind !== 'summary') throw new HttpError(400, `"${name}" must go inside a phase of this project.`);
        if (rows[0].not_required) throw new HttpError(400, `"${name}" cannot go inside a phase marked Not required.`);
      } else parentId = null;
      changes.newMilestones.push({ name, date: d, parentId });
    }
    areas.add('scope');
  }
  return { changes, snapshot, areas: [...areas] };
}

/** The head of the project's department, when there is an active one. */
export async function headOf(q: Queryable, projectId: number): Promise<number | null> {
  const { rows } = await q.query(
    `SELECT u.id FROM projects p JOIN departments d ON d.id = p.department_id JOIN users u ON u.id = d.head_user_id WHERE p.id = $1 AND u.active = 1`,
    [projectId],
  );
  return rows[0]?.id ?? null;
}

/** The accounts that give the PMO's final approval: the roles holding "changes.approve". */
export async function changeApprovers(q: Queryable): Promise<number[]> {
  const { rows } = await q.query('SELECT u.id, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1');
  return rows.filter((r) => normalizePermissions(r.permissions).includes('changes.approve')).map((r) => r.id as number);
}

/**
 * Applies an approved change inside the caller's transaction, and says what it did. A milestone that is no longer
 * in the plan is skipped (and said so). New dates become the approved ones: the baseline follows them.
 */
export async function applyChange(q: Queryable, projectId: number, cr: ChangeRequest, decidedBy: number): Promise<string[]> {
  const done: string[] = [];
  const c = cr.changes;
  const tag = `${cr.code}: ${cr.description}`.slice(0, 480);
  const sets: string[] = [];
  const vals: unknown[] = [projectId];
  const set = (col: string, v: unknown) => (vals.push(v), sets.push(`${col} = $${vals.length}`));
  if (c.startDate) (set('start_date', c.startDate), set('baseline_start', c.startDate), done.push(`Start date set to ${c.startDate}`));
  if (c.endDate) (set('end_date', c.endDate), set('baseline_end', c.endDate), done.push(`End date set to ${c.endDate}`));
  if (c.budget !== undefined) (set('budget', c.budget), done.push(c.budget === null ? 'Budget cleared' : `Budget set to ${c.budget}`));
  if (c.scope !== undefined) (set('scope', c.scope || null), done.push('Scope updated'));
  if (c.objective !== undefined) (set('objective', c.objective || null), done.push('Objective updated'));
  if (sets.length) await q.query(`UPDATE projects SET ${sets.join(', ')}, updated_at = SYSDATETIMEOFFSET() WHERE id = $1`, vals);

  for (const m of c.milestones ?? []) {
    const { rows } = await q.query(`SELECT id, name, start_date, end_date FROM tasks WHERE id = $1 AND project_id = $2 AND kind = 'milestone'`, [m.taskId, projectId]);
    const t = rows[0];
    if (!t) {
      done.push(`A milestone of this request is no longer in the plan: skipped`);
      continue;
    }
    if (m.action === 'cancel') {
      await q.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [t.id]);
      done.push(`"${t.name}" cancelled`);
      continue;
    }
    const to = m.to as string;
    await q.query('UPDATE tasks SET start_date = $2, end_date = $2, baseline_start = $2, baseline_end = $2 WHERE id = $1', [t.id, to]);
    await q.query(
      `INSERT INTO deadline_changes (task_id, from_date, to_date, reason, requested_by, status, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, 'approved', $6, SYSDATETIMEOFFSET())`,
      [t.id, t.end_date, to, tag, cr.requestedBy, decidedBy],
    );
    await pushSuccessors(q, projectId, t.id, t.name, cr.code);
    done.push(`"${t.name}" moved from ${t.end_date} to ${to}`);
  }

  for (const m of c.newMilestones ?? []) {
    const { rows } = await q.query('SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM tasks WHERE project_id = $1', [projectId]);
    const parent = m.parentId ? (await q.query(`SELECT id FROM tasks WHERE id = $1 AND project_id = $2 AND kind = 'summary'`, [m.parentId, projectId])).rows[0]?.id ?? null : null;
    await q.query(
      `INSERT INTO tasks (project_id, parent_id, kind, name, start_date, end_date, baseline_start, baseline_end, sort)
       VALUES ($1, $2, 'milestone', $3, $4, $4, $4, $4, $5)`,
      [projectId, parent, m.name, m.date, rows[0].s],
    );
    done.push(`Milestone "${m.name}" added for ${m.date}`);
  }
  await resync(q, projectId);
  return done;
}

/** The next number in the project's change log (CR-001, CR-002...). */
export async function nextSeq(q: Queryable, projectId: number): Promise<number> {
  const { rows } = await q.query('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM change_requests WITH (UPDLOCK, HOLDLOCK) WHERE project_id = $1', [projectId]);
  return rows[0].n;
}

