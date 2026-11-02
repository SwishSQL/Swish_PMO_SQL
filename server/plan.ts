import type { Queryable } from './db';
import { HttpError } from './auth';
import { mapDependency, mapTask } from './mappers';
import { loadCalendar } from './calendar';
import { propagate } from '../shared/schedule';

/**
 * Whether the project has an approved baseline. From then on its scope, cost and schedule (the project's dates and
 * budget, its scope and objective, and its milestones) change only through an approved change request.
 */
export async function isBaselined(q: Queryable, projectId: number): Promise<boolean> {
  const { rows } = await q.query('SELECT CASE WHEN baseline_end IS NOT NULL THEN 1 ELSE 0 END AS b FROM projects WHERE id = $1', [projectId]);
  return Boolean(rows[0]?.b);
}

export function lockedError(what: string): HttpError {
  return new HttpError(409, `This project has an approved baseline: ${what} changes only through an approved change request. Raise one from the Changes tab.`);
}

/**
 * Push successors forward after a move, inside the caller's transaction. In a project with an approved baseline a
 * push that would move a milestone is refused, unless it comes from an approved change request (viaChange), whose
 * new dates become the approved ones.
 */
export async function pushSuccessors(q: Queryable, projectId: number, movedId: number, cause: string, viaChange?: string): Promise<void> {
  const [t, d, cal] = await Promise.all([
    q.query('SELECT * FROM tasks WHERE project_id = $1', [projectId]),
    q.query('SELECT * FROM task_dependencies WHERE project_id = $1', [projectId]),
    loadCalendar(q),
  ]);
  const changed = propagate(t.rows.map(mapTask), d.rows.map(mapDependency), movedId, cal);
  const before = new Map<number, any>(t.rows.map((r: any) => [r.id as number, r]));
  const locked = !viaChange && (await isBaselined(q, projectId));
  for (const [id, v] of changed) {
    const old = before.get(id);
    if (locked && old && old.kind === 'milestone' && old.end_date !== v.endDate) {
      throw lockedError(`this would push the milestone "${old.name}" to a new date, and a milestone's date`);
    }
    await q.query('UPDATE tasks SET start_date = $2, end_date = $3 WHERE id = $1', [id, v.startDate, v.endDate]);
    // A milestone pushed along by its predecessor is a move too: on record, approved, and its
    // original deadline kept the first time it shifts (or, by a change request, the new approved date).
    if (old && old.kind === 'milestone' && old.end_date !== v.endDate) {
      await q.query(
        `INSERT INTO deadline_changes (task_id, from_date, to_date, reason, status, automatic) VALUES ($1, $2, $3, $4, 'approved', 1)`,
        [id, old.end_date, v.endDate, viaChange ? `Moved with "${cause}" (${viaChange})` : `Moved with "${cause}"`],
      );
      if (viaChange) {
        await q.query('UPDATE tasks SET baseline_start = $2, baseline_end = $2 WHERE id = $1', [id, v.endDate]);
      } else {
        await q.query('UPDATE tasks SET baseline_start = COALESCE(baseline_start, $2), baseline_end = COALESCE(baseline_end, $3) WHERE id = $1', [
          id,
          old.start_date,
          old.end_date,
        ]);
      }
    }
  }
}
