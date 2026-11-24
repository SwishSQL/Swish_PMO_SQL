import type { Queryable } from './db';
import { db } from './db';
import { HttpError } from './auth';
import { notify } from './notify';
import type { ProjectLink } from '../shared/types';

// Projects that wait for others. The PMO links a project to the ones it depends on; until every one of them is closed
// (or archived) the project does not start: its plan can be prepared, but no progress, no update and no baseline.
// A project that had already started when it was linked is not frozen: it only shows what it depends on.

export async function dependsOn(projectId: number, q: Queryable = db): Promise<ProjectLink[]> {
  const { rows } = await q.query(
    `SELECT p.id, p.code, p.name, p.health, CONVERT(CHAR(10), p.end_date, 23) AS end_date, p.archived, d.started_before
       FROM project_dependencies d JOIN projects p ON p.id = d.depends_on_id
      WHERE d.project_id = $1 ORDER BY p.code`,
    [projectId],
  );
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, endDate: r.end_date, open: r.health !== 'done' && !r.archived, startedBefore: r.started_before }));
}

/** For a list: each project's open predecessors that hold it back. */
export async function blockedByMap(q: Queryable = db): Promise<Map<number, { id: number; code: string; name: string }[]>> {
  const { rows } = await q.query(
    `SELECT d.project_id, p.id, p.code, p.name FROM project_dependencies d JOIN projects p ON p.id = d.depends_on_id
      WHERE p.health <> 'done' AND p.archived = 0 AND d.started_before = 0`,
  );
  const out = new Map<number, { id: number; code: string; name: string }[]>();
  for (const r of rows) out.set(r.project_id, [...(out.get(r.project_id) ?? []), { id: r.id, code: r.code, name: r.name }]);
  return out;
}

/** Refuses what starts the work (progress, an update, the baseline) while a project it depends on is still open. */
export async function assertNotBlocked(projectId: number, what: string, q: Queryable = db): Promise<void> {
  const { rows } = await q.query(
    `SELECT p.code, p.name FROM project_dependencies d JOIN projects p ON p.id = d.depends_on_id
      WHERE d.project_id = $1 AND d.started_before = 0 AND p.health <> 'done' AND p.archived = 0 ORDER BY p.code`,
    [projectId],
  );
  if (rows.length) {
    throw new HttpError(409, `This project waits for ${rows.map((r) => `${r.code} (${r.name})`).join(', ')} to close: ${what} can start after that. The plan can be prepared meanwhile.`);
  }
}

/** The PMO sets what a project depends on: no loops, no project on itself. */
export async function setDependsOn(projectId: number, ids: number[], userId: number): Promise<void> {
  const want = [...new Set(ids)];
  if (want.includes(projectId)) throw new HttpError(400, 'A project cannot depend on itself.');
  if (want.length) {
    const { rows: found } = await db.query('SELECT id FROM projects WHERE id IN (SELECT value FROM OPENJSON($1))', [want]);
    if (found.length !== want.length) throw new HttpError(400, 'One of those projects does not exist.');
  }
  // A loop: one of the new predecessors already depends, directly or not, on this project.
  const { rows: all } = await db.query('SELECT project_id, depends_on_id FROM project_dependencies WHERE project_id <> $1', [projectId]);
  const next = new Map<number, number[]>();
  for (const r of all) next.set(r.project_id, [...(next.get(r.project_id) ?? []), r.depends_on_id]);
  for (const start of want) {
    const seen = new Set<number>();
    const stack = [start];
    while (stack.length) {
      const at = stack.pop()!;
      if (at === projectId) {
        const { rows } = await db.query('SELECT code FROM projects WHERE id = $1', [start]);
        throw new HttpError(400, `${rows[0]?.code ?? 'That project'} already waits for this one: they cannot wait for each other.`);
      }
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(next.get(at) ?? []));
    }
  }
  await db.tx(async (q) => {
    const { rows: p } = await q.query('SELECT stage, progress FROM projects WHERE id = $1', [projectId]);
    // Already under way when linked: not frozen, only shown.
    const started = p[0].stage !== 'initiation' || Number(p[0].progress) > 0;
    await q.query('DELETE FROM project_dependencies WHERE project_id = $1 AND depends_on_id NOT IN (SELECT value FROM OPENJSON($2))', [projectId, want]);
    for (const d of want) {
      await q.query(
        `INSERT INTO project_dependencies (project_id, depends_on_id, started_before, created_by)
         SELECT $1, $2, $3, $4
          WHERE NOT EXISTS (SELECT 1 FROM project_dependencies WITH (UPDLOCK, HOLDLOCK) WHERE project_id = $1 AND depends_on_id = $2)`,
        [projectId, d, started, userId],
      );
    }
  });
}

/** A project closed: the ones that waited only for it (or for others now closed too) may start. Their managers are told. */
export async function releaseDependents(closedId: number, byUserId: number | null): Promise<void> {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.manager_id, c.name AS closed_name
       FROM project_dependencies d JOIN projects p ON p.id = d.project_id JOIN projects c ON c.id = d.depends_on_id
      WHERE d.depends_on_id = $1 AND p.archived = 0 AND p.health <> 'done'
        AND NOT EXISTS (SELECT 1 FROM project_dependencies o JOIN projects op ON op.id = o.depends_on_id
                         WHERE o.project_id = p.id AND op.health <> 'done' AND op.archived = 0)`,
    [closedId],
  );
  for (const r of rows) {
    await notify(db, [r.manager_id], { kind: 'project.unblocked', projectId: r.id, data: { project: r.name, name: r.closed_name } }, byUserId);
  }
}
