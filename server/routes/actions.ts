import { Router } from 'express';
import { db } from '../db';
import { can, canGovernProject, canManageAccounts, route } from '../auth';
import { ladder } from '../escalation';
import { loadCalendar } from '../calendar';
import { addDays, todayIso } from '../../shared/dates';
import type { MyAction } from '../../shared/types';

// What waits for this person to act on, for the "Needs your action" pop-up: escalations that reached them, date
// changes and change requests waiting for their decision, closures waiting for the PMO, and plans whose new
// milestones still have no approved dates. Information alone stays in the notification center.
export const actionsRouter = Router();

actionsRouter.get(
  '/my-actions',
  route(async (req, res) => {
    const me = req.user!.id;
    const today = todayIso();
    const out: MyAction[] = [];

    // Escalations: the highest open level of each milestone, when that level is this person.
    const cal = await loadCalendar(db);
    const { rows: escs } = await db.query(
      `SELECT x.id, x.task_id, x.level, x.name, x.project_id, x.code, x.raised_on
         FROM (SELECT e.id, e.task_id, e.level, t.name, t.project_id, p.code,
                      CONVERT(CHAR(10), CAST(e.raised_at AT TIME ZONE 'Arab Standard Time' AS DATE), 23) AS raised_on,
                      ROW_NUMBER() OVER (PARTITION BY e.task_id ORDER BY e.level DESC, e.id DESC) AS rn
                 FROM escalations e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
                WHERE e.resolved_at IS NULL AND p.archived = 0 AND p.health <> 'done' AND t.status NOT IN ('done', 'cancelled')) x
        WHERE x.rn = 1
        ORDER BY x.task_id`,
    );
    for (const e of escs) {
      const step = (await ladder(db, e.task_id))[e.level - 1];
      if (!step?.userIds.includes(me)) continue;
      const waited = e.raised_on < today ? cal.workdays(addDays(e.raised_on, 1), today) : 0;
      out.push({ key: `esc:${e.id}`, kind: 'escalation', projectId: e.project_id, projectCode: e.code, taskId: e.task_id, title: e.name, level: e.level, days: waited });
    }

    // A team member's date move waiting for the person who runs the project.
    const { rows: moves } = await db.query(
      `SELECT c.id, c.task_id, c.to_date, t.name, t.project_id, p.code
         FROM deadline_changes c JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
        WHERE c.status = 'pending' AND p.archived = 0 AND (c.requested_by IS NULL OR c.requested_by <> $1)`,
      [me],
    );
    for (const m of moves) {
      if (!(await canGovernProject(req, m.project_id))) continue;
      out.push({ key: `move:${m.id}`, kind: 'date_change', projectId: m.project_id, projectCode: m.code, taskId: m.task_id, title: m.name, date: String(m.to_date).slice(0, 10) });
    }

    // Change requests at this person's step: the department head first, then the PMO.
    const { rows: crs } = await db.query(
      `SELECT c.id, c.seq, c.description, c.project_id, p.code
         FROM change_requests c JOIN projects p ON p.id = c.project_id LEFT JOIN departments d ON d.id = p.department_id
        WHERE c.status IN ('pending', 'on_hold') AND (c.requested_by IS NULL OR c.requested_by <> $1) AND p.archived = 0
          AND ((c.stage = 'head' AND d.head_user_id = $1) OR (c.stage = 'pmo' AND $2 = 1))`,
      [me, can(req, 'changes.approve')],
    );
    for (const c of crs) out.push({ key: `cr:${c.id}`, kind: 'change_request', projectId: c.project_id, projectCode: c.code, title: c.description });

    // Closure requests, for the PMO (owners and executives may close projects, but are not asked to).
    if (can(req, 'projects.approve_close') && can(req, 'projects.edit_all')) {
      const { rows: cl } = await db.query(
        `SELECT c.id, c.project_id, p.code, p.name FROM closure_requests c JOIN projects p ON p.id = c.project_id
          WHERE c.status = 'pending' AND (c.requested_by IS NULL OR c.requested_by <> $1)`,
        [me],
      );
      for (const c of cl) out.push({ key: `close:${c.id}`, kind: 'closure', projectId: c.project_id, projectCode: c.code, title: c.name });
    }

    // My own milestones (owner or co-owner) due within 3 working days, or already late: a reminder before the date.
    const soonTo = cal.addWorkdays(today, 3);
    const { rows: mine } = await db.query(
      `SELECT t.id, t.name, CONVERT(CHAR(10), t.end_date, 23) AS due, t.project_id, p.code
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.kind = 'milestone' AND t.system_key IS NULL AND t.not_required = 0 AND t.status NOT IN ('done', 'cancelled')
          AND p.archived = 0 AND p.health <> 'done' AND t.end_date <= $2
          AND (t.assignee_id = $1 OR EXISTS (SELECT 1 FROM task_coowners c WHERE c.task_id = t.id AND c.user_id = $1))
        ORDER BY t.end_date`,
      [me, soonTo],
    );
    for (const m of mine) out.push({ key: `due:${m.id}:${m.due}`, kind: 'due', projectId: m.project_id, projectCode: m.code, taskId: m.id, title: m.name, date: m.due });

    // Plans this person runs (owner or department head): items with no approved date yet (the whole plan when it
    // was never baselined), and milestones nobody owns.
    const { rows: plans } = await db.query(
      `SELECT p.id, p.code, p.name, CASE WHEN p.baseline_end IS NULL THEN 1 ELSE 0 END AS [first],
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind <> 'summary' AND t.system_key IS NULL
                 AND t.baseline_end IS NULL AND t.status <> 'cancelled') AS missing,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone' AND t.system_key IS NULL
                 AND t.not_required = 0 AND t.status NOT IN ('done', 'cancelled') AND t.assignee_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM task_coowners c WHERE c.task_id = t.id)) AS unowned
         FROM projects p LEFT JOIN departments d ON d.id = p.department_id
        WHERE p.archived = 0 AND p.health <> 'done'
          AND (p.manager_id = $1 OR d.head_user_id = $1)`,
      [me],
    );
    for (const p of plans) {
      const first = !!p.first;
      if (p.missing > 0) out.push({ key: `base:${p.id}:${p.missing}:${first ? 1 : 0}`, kind: 'baseline', projectId: p.id, projectCode: p.code, title: p.name, count: p.missing, first });
      if (p.unowned > 0) out.push({ key: `owner:${p.id}:${p.unowned}`, kind: 'no_owner', projectId: p.id, projectCode: p.code, title: p.name, count: p.unowned });
    }

    // Projects I run that waited for others, all closed now, and not started yet.
    const { rows: free } = await db.query(
      `SELECT p.id, p.code, p.name FROM projects p
        WHERE p.manager_id = $1 AND p.archived = 0 AND p.health <> 'done' AND p.stage = 'initiation' AND p.progress = 0
          AND EXISTS (SELECT 1 FROM project_dependencies d WHERE d.project_id = p.id AND d.started_before = 0)
          AND NOT EXISTS (SELECT 1 FROM project_dependencies d JOIN projects o ON o.id = d.depends_on_id
                           WHERE d.project_id = p.id AND o.health <> 'done' AND o.archived = 0)`,
      [me],
    );
    for (const p of free) out.push({ key: `start:${p.id}`, kind: 'can_start', projectId: p.id, projectCode: p.code, title: p.name });

    // Someone named me in a comment, not opened yet (the last 30 days).
    const { rows: ments } = await db.query(
      `SELECT TOP (20) n.id, n.project_id, n.task_id, n.data, p.code FROM notifications n LEFT JOIN projects p ON p.id = n.project_id
        WHERE n.user_id = $1 AND n.kind = 'mention' AND n.read_at IS NULL AND n.created_at > DATEADD(DAY, -30, SYSDATETIMEOFFSET())
        ORDER BY n.created_at DESC`,
      [me],
    );
    for (const m of ments) {
      out.push({
        key: `mention:${m.id}`, kind: 'mention', projectId: m.project_id, projectCode: m.code ?? '', taskId: m.task_id ?? undefined,
        title: m.data?.name || m.data?.project || '', noteId: m.id, by: m.data?.by, excerpt: m.data?.excerpt,
      });
    }

    // Notices that need an eye, not opened yet: work or a risk given to me, a project handed to me, and refusals
    // (a date move, a change, a closure, an owner request turned down).
    const { rows: notes } = await db.query(
      `SELECT TOP (20) n.id, n.kind, n.project_id, n.task_id, n.data, p.code FROM notifications n LEFT JOIN projects p ON p.id = n.project_id
        WHERE n.user_id = $1 AND n.read_at IS NULL AND n.created_at > DATEADD(DAY, -30, SYSDATETIMEOFFSET())
          AND (n.kind IN ('task.assigned', 'task.coowner', 'risk.assigned', 'project.owner', 'meeting.owner')
               OR (n.kind IN ('deadline.decided', 'change.decided', 'closure.decided', 'owner.decided') AND JSON_VALUE(n.data, '$.decision') IN ('reject', 'decline')))
        ORDER BY n.created_at DESC`,
      [me],
    );
    for (const n of notes) {
      out.push({
        key: `note:${n.id}`, kind: 'note', projectId: n.project_id, projectCode: n.code ?? '', taskId: n.task_id ?? undefined,
        title: n.data?.name || n.data?.project || '', noteId: n.id, noteKind: n.kind, noteData: n.data ?? {},
      });
    }

    // Owners asked of my department (or of the PMO, or a new account for a system admin).
    const { rows: asks } = await db.query(
      `SELECT r.id, r.new_email, d.head_user_id, t.name, t.project_id, p.code FROM owner_requests r
         JOIN departments d ON d.id = r.department_id JOIN tasks t ON t.id = r.task_id JOIN projects p ON p.id = t.project_id
        WHERE r.status = 'pending'`,
    );
    for (const a of asks) {
      const mine = a.new_email ? canManageAccounts(req) : a.head_user_id === me || (!a.head_user_id && can(req, 'projects.edit_all'));
      if (mine) out.push({ key: `ownreq:${a.id}`, kind: 'owner_request', projectId: a.project_id, projectCode: a.code, taskId: undefined, title: a.name, date: a.new_email ? 'new' : undefined });
    }

    res.json(out);
  }),
);
