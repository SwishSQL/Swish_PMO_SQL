import type { Queryable } from './db';
import { db } from './db';
import { projectVisibleSql } from './visibility';
import {
  mapActivity,
  mapClosure,
  mapDependency,
  mapNote,
  mapProject,
  mapRisk,
  mapTask,
  mapUpdate,
} from './mappers';
import type { ProjectDetail, ProjectSummary, Task } from '../shared/types';
import { projectProgress, rollUp } from '../shared/schedule';
import { todayIso } from '../shared/dates';

export async function logActivity(
  q: Queryable,
  projectId: number | null,
  userId: number | null,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await q.query('INSERT INTO activity (project_id, user_id, action, detail) VALUES ($1, $2, $3, $4)', [
    projectId,
    userId,
    action,
    JSON.stringify(detail),
  ]);
}

const SUMMARY_SQL = `
  SELECT p.*, mu.name AS manager_name,
    COALESCE((
      SELECT t.id AS id, t.name AS name, t.end_date AS [date],
        t.baseline_end AS baselineDate, CAST(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END AS BIT) AS done
      FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone' AND t.status <> 'cancelled'
      ORDER BY t.end_date, t.sort
      FOR JSON PATH, INCLUDE_NULL_VALUES
    ), '[]') AS milestones__json,
    (SELECT TOP (1) t.blocker FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone'
        AND t.status NOT IN ('done','cancelled') AND t.blocker IS NOT NULL ORDER BY t.end_date) AS blocker,
    (SELECT TOP (1) t.update_comment FROM tasks t WHERE t.project_id = p.id AND t.update_comment IS NOT NULL
        AND t.status NOT IN ('done','cancelled')
        ORDER BY CASE WHEN t.update_comment_on IS NULL THEN 1 ELSE 0 END, t.update_comment_on DESC, t.end_date) AS last_comment,
    (SELECT max(u.week_start) FROM status_updates u WHERE u.project_id = p.id) AS last_update_week,
    (SELECT count(*) FROM risks r WHERE r.project_id = p.id AND r.status <> 'closed') AS open_risks
  FROM projects p
  LEFT JOIN users mu ON mu.id = p.manager_id
`;

function normaliseMilestones(raw: unknown): ProjectSummary['milestones'] {
  const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(list) ? list : [];
}

/**
 * quarterId: projects whose dates overlap that quarter, so a project that runs
 * from September to December shows in both Q3 and Q4. A project still open
 * (not done, not closed) after its planned finish also stays in every quarter
 * that has started since:
 * a late project is still this quarter's work, and the weekly review must
 * see it.
 * visibleTo: a user id when the viewer may only see projects they manage or belong to.
 */
export async function listProjects(quarterId: number | null, visibleTo: number | null = null): Promise<ProjectSummary[]> {
  const { rows } = await db.query(
    `${SUMMARY_SQL}
      WHERE p.archived = 0
        AND ($1 IS NULL OR EXISTS (
              SELECT 1 FROM quarters q
               WHERE q.id = $1 AND p.start_date <= q.ends_on
                 AND (p.end_date >= q.starts_on
                      OR (q.starts_on <= CAST($3 AS DATE) AND p.stage <> 'closed' AND p.health <> 'done' AND p.progress < 100))))
        AND ${projectVisibleSql('p', '$2')}
      ORDER BY p.code`,
    [quarterId, visibleTo, todayIso()],
  );
  return rows.map((r) => {
    const p = mapProject({ ...r, milestones: normaliseMilestones(r.milestones) });
    const { description, objective, scope, baselineStart, createdAt, updatedAt, ...summary } = p;
    void description, objective, scope, baselineStart, createdAt, updatedAt;
    return summary;
  });
}

export async function loadDetail(projectId: number): Promise<ProjectDetail | null> {
  const { rows } = await db.query(`${SUMMARY_SQL} WHERE p.id = $1`, [projectId]);
  if (!rows[0]) return null;
  const project = mapProject({ ...rows[0], milestones: normaliseMilestones(rows[0].milestones) });
  const [members, tasks, deps, updates, notes, risks, activity, closure] = await Promise.all([
    db.query('SELECT user_id, role FROM project_members WHERE project_id = $1 ORDER BY role, user_id', [projectId]),
    db.query('SELECT * FROM tasks WHERE project_id = $1 ORDER BY sort, id', [projectId]),
    db.query('SELECT * FROM task_dependencies WHERE project_id = $1', [projectId]),
    db.query('SELECT * FROM status_updates WHERE project_id = $1 ORDER BY week_start DESC', [projectId]),
    db.query(
      `SELECT n.* FROM meeting_notes n JOIN status_updates u ON u.id = n.update_id
        WHERE u.project_id = $1 ORDER BY n.created_at`,
      [projectId],
    ),
    db.query(
      `SELECT * FROM risks WHERE project_id = $1
        ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END, CASE impact WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at`,
      [projectId],
    ),
    db.query('SELECT TOP (60) * FROM activity WHERE project_id = $1 ORDER BY created_at DESC', [projectId]),
    db.query(
      `SELECT TOP (1) c.id, c.project_id, c.requested_by, c.note, c.status, c.decided_by, c.decided_at, c.decision_note, c.created_at, c.delivery_url, c.delivery_file_name, c.report_file_name, c.checklist_file_name, rq.name AS requested_by_name, dc.name AS decided_by_name FROM closure_requests c
         LEFT JOIN users rq ON rq.id = c.requested_by LEFT JOIN users dc ON dc.id = c.decided_by
        WHERE c.project_id = $1 ORDER BY c.created_at DESC, c.id DESC`,
      [projectId],
    ),
  ]);
  const notesByUpdate = new Map<number, ReturnType<typeof mapNote>[]>();
  for (const n of notes.rows.map(mapNote)) {
    const l = notesByUpdate.get(n.updateId);
    if (l) l.push(n);
    else notesByUpdate.set(n.updateId, [n]);
  }
  return {
    project,
    members: members.rows.map((m) => ({ userId: m.user_id, role: m.role })),
    tasks: tasks.rows.map(mapTask),
    dependencies: deps.rows.map(mapDependency),
    updates: updates.rows.map((u) => mapUpdate(u, notesByUpdate.get(u.id) ?? [])),
    risks: risks.rows.map(mapRisk),
    activity: activity.rows.map(mapActivity),
    closure: closure.rows[0] ? mapClosure(closure.rows[0]) : null,
  };
}

/**
 * Re-derives everything computed from the plan: summary rows, the project's
 * window and its progress. Call inside the same transaction as the edit.
 */
export async function resync(q: Queryable, projectId: number): Promise<void> {
  const { rows } = await q.query('SELECT * FROM tasks WHERE project_id = $1', [projectId]);
  const tasks: Task[] = rows.map(mapTask);
  if (tasks.length === 0) return;
  const rolled = rollUp(tasks);
  const before = new Map(tasks.map((t) => [t.id, t]));
  for (const t of rolled) {
    const b = before.get(t.id)!;
    if (b.startDate !== t.startDate || b.endDate !== t.endDate || b.progress !== t.progress) {
      await q.query('UPDATE tasks SET start_date = $2, end_date = $3, progress = $4 WHERE id = $1', [
        t.id,
        t.startDate,
        t.endDate,
        t.progress,
      ]);
    }
  }
  let start = rolled.reduce((m, t) => (t.startDate < m ? t.startDate : m), rolled[0].startDate);
  let end = rolled.reduce((m, t) => (t.endDate > m ? t.endDate : m), rolled[0].endDate);
  // The committed window (baseline) is the floor: a project never reports a
  // finish earlier than its target just because its milestones end sooner.
  const { rows: base } = await q.query('SELECT baseline_start, baseline_end FROM projects WHERE id = $1', [projectId]);
  if (base[0]?.baseline_start && base[0].baseline_start < start) start = base[0].baseline_start;
  if (base[0]?.baseline_end && base[0].baseline_end > end) end = base[0].baseline_end;
  await q.query(
    'UPDATE projects SET start_date = $2, end_date = $3, progress = $4, updated_at = SYSDATETIMEOFFSET() WHERE id = $1',
    [projectId, start, end, projectProgress(rolled)],
  );
}

export async function nextProjectCode(q: Queryable): Promise<string> {
  const { rows } = await q.query(
    `SELECT COALESCE(MAX(TRY_CAST(SUBSTRING(code, 5, 20) AS INT)), 0) + 1 AS n FROM projects WHERE code LIKE 'PRJ-%'`,
  );
  return `PRJ-${String(rows[0].n).padStart(3, '0')}`;
}

// ---- What a team member sees of a plan ----------------------------------------------------------
// The owner, the department head and the PMO see the whole plan. Everyone else sees the tasks given to
// them, with the phases above those tasks so they sit in context, and nothing else.

/** Ids of the tasks given to this person, as owner or co-owner. */
export async function myTaskIds(userId: number, projectId?: number): Promise<Set<number>> {
  const { rows } = await db.query(
    `SELECT t.id FROM tasks t
      WHERE (t.assignee_id = $1 OR EXISTS (SELECT 1 FROM task_coowners c WHERE c.task_id = t.id AND c.user_id = $1))
        AND ($2 IS NULL OR t.project_id = $2)`,
    [userId, projectId ?? null],
  );
  return new Set(rows.map((r) => r.id as number));
}

/** Ids of the projects this person runs: owns, or heads the department of. */
export async function runProjectIds(userId: number): Promise<Set<number>> {
  const { rows } = await db.query(
    `SELECT p.id FROM projects p WHERE p.manager_id = $1
        OR EXISTS (SELECT 1 FROM departments d WHERE d.id = p.department_id AND d.head_user_id = $1)`,
    [userId],
  );
  return new Set(rows.map((r) => r.id as number));
}

/** A plan as a person without the whole-plan view sees it: their tasks and the phases above them. */
export function restrictPlan<P extends { tasks: Task[]; dependencies: ProjectDetail['dependencies'] }>(plan: P, mine: Set<number>): P {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const keep = new Set<number>();
  for (const id of mine) {
    for (let t = byId.get(id); t && !keep.has(t.id); t = t.parentId ? byId.get(t.parentId) : undefined) keep.add(t.id);
  }
  return {
    ...plan,
    tasks: plan.tasks.filter((t) => keep.has(t.id)),
    dependencies: plan.dependencies.filter((d) => keep.has(d.predecessorId) && keep.has(d.successorId)),
  };
}

/** The plan cut down to the person's own tasks (plus the phases above them). */
export function restrictDetail(detail: ProjectDetail, mine: Set<number>): ProjectDetail {
  const cut = restrictPlan(detail, mine);
  return {
    ...detail,
    ...cut,
    project: { ...detail.project, milestones: detail.project.milestones.filter((m) => mine.has(m.id)) },
  };
}
