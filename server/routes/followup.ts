import { Router } from 'express';
import type { Request } from 'express';
import { db } from '../db';
import { HttpError, canEditProject, canGovernProject, canViewProject, isMyTask, route, seesWholePlan, can } from '../auth';
import { mapDeadlineChange, mapEscalation } from '../mappers';
import { logActivity, resync } from '../service';
import { deciders, notify } from '../notify';
import { climbEscalations, ladder, nextStep, TOP } from '../escalation';
import { requirePermission } from '../auth';
import { optDate } from '../validate';
import { idParam, oneOf, optStr, str } from '../validate';

// What follows a milestone around: the moves of its deadline (with reasons and approval) and the
// escalations raised on it. The deadline moves themselves are written by PATCH /tasks/:id.
export const followupRouter = Router();

async function taskInfo(taskId: number): Promise<{ projectId: number; name: string; kind: string; endDate: string; status: string }> {
  const { rows } = await db.query('SELECT project_id, name, kind, end_date, status FROM tasks WHERE id = $1', [taskId]);
  if (!rows[0]) throw new HttpError(404, 'Task not found.');
  return { projectId: rows[0].project_id, name: rows[0].name, kind: rows[0].kind, endDate: rows[0].end_date, status: rows[0].status };
}

/** Whoever sees the project sees its tasks, except that a team member sees only the ones given to them. */
async function assertView(req: Request, projectId: number, taskId?: number): Promise<void> {
  if (!(await canViewProject(req, projectId))) throw new HttpError(404, 'Task not found.');
  if (taskId !== undefined && !(await seesWholePlan(req, projectId)) && !(await isMyTask(req.user!.id, taskId))) {
    throw new HttpError(404, 'Task not found.');
  }
}

/** Raising or closing an escalation: those who change the plan, and each team member on their own tasks. */
async function assertCanEscalate(req: Request, projectId: number, taskId: number, message: string): Promise<void> {
  if (!(await canEditProject(req, projectId))) throw new HttpError(403, message);
  if (!(await seesWholePlan(req, projectId)) && !(await isMyTask(req.user!.id, taskId))) throw new HttpError(403, message);
}

// ---- Deadline changes ---------------------------------------------------------

followupRouter.get(
  '/tasks/:taskId/changes',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    await assertView(req, (await taskInfo(taskId)).projectId, taskId);
    const { rows } = await db.query('SELECT * FROM deadline_changes WHERE task_id = $1 ORDER BY requested_at DESC, id DESC', [taskId]);
    res.json(rows.map(mapDeadlineChange));
  }),
);

/** Deadline changes waiting for a decision, on the projects this person governs (all of them for the PMO). */
followupRouter.get(
  '/deadline-changes/pending',
  route(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.*, t.name AS task_name, t.code AS task_code, t.project_id, p.code AS project_code, p.manager_id
         FROM deadline_changes c JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
        WHERE c.status = 'pending' AND p.archived = 0 ORDER BY c.requested_at`,
    );
    const out = [];
    for (const r of rows) if (await canGovernProject(req, r.project_id)) out.push({ ...mapDeadlineChange(r), taskName: r.task_name, taskCode: r.task_code, projectId: r.project_id, projectCode: r.project_code });
    res.json(out);
  }),
);

/** The project manager or the PMO approves a team member's move, or rejects it and the date goes back. */
followupRouter.post(
  '/deadline-changes/:id/decide',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const decision = oneOf(req.body?.decision, 'Decision', ['approve', 'reject'] as const);
    const { rows } = await db.query('SELECT * FROM deadline_changes WHERE id = $1', [id]);
    const c = rows[0];
    if (!c) throw new HttpError(404, 'Change not found.');
    const task = await taskInfo(c.task_id);
    if (!(await canGovernProject(req, task.projectId))) throw new HttpError(403, 'Only the project manager or the PMO decides on a new deadline.');
    if (c.status !== 'pending') throw new HttpError(409, 'This change was already decided.');
    // Nobody signs off their own request (a manager's own moves never wait: they are approved when made).
    if (c.requested_by === req.user!.id) throw new HttpError(403, 'Someone else decides on your request.');
    await db.tx(async (q) => {
      if (decision === 'reject') {
        // The date goes back, only if nobody has moved it again since.
        if (task.endDate !== c.to_date) throw new HttpError(409, 'The deadline has moved again since. Review it by hand.');
        await q.query('UPDATE tasks SET start_date = $2, end_date = $2 WHERE id = $1', [c.task_id, c.from_date]);
        await resync(q, task.projectId);
      }
      await q.query(`UPDATE deadline_changes SET status = $2, decided_by = $3, decided_at = SYSDATETIMEOFFSET() WHERE id = $1`, [id, decision === 'approve' ? 'approved' : 'rejected', req.user!.id]);
      await logActivity(q, task.projectId, req.user!.id, decision === 'approve' ? 'deadline.approved' : 'deadline.rejected', {
        taskId: c.task_id,
        name: task.name,
        from: c.from_date,
        to: c.to_date,
      });
    });
    await notify(db, [c.requested_by], {
      kind: 'deadline.decided',
      projectId: task.projectId,
      taskId: c.task_id,
      data: { name: task.name, from: c.from_date, to: c.to_date, decision, by: req.user!.name },
    }, req.user!.id);
    const { rows: after } = await db.query('SELECT * FROM deadline_changes WHERE id = $1', [id]);
    res.json(mapDeadlineChange(after[0]));
  }),
);

// ---- Escalations --------------------------------------------------------------
// The same ladder on every project: 1 the project manager, 2 the department head (or, without one, the initiative
// owner the tracker names), 3 the PMO, 4 the executives for major blockers. A team member raises level 1; whoever
// runs the project raises it further, one step at a time.

followupRouter.get(
  '/tasks/:taskId/escalation-ladder',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    await assertView(req, (await taskInfo(taskId)).projectId, taskId);
    res.json((await ladder(db, taskId)).map(({ userIds, ...s }) => (void userIds, s)));
  }),
);

followupRouter.get(
  '/tasks/:taskId/escalations',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    await assertView(req, (await taskInfo(taskId)).projectId, taskId);
    const { rows } = await db.query('SELECT * FROM escalations WHERE task_id = $1 ORDER BY raised_at DESC, id DESC', [taskId]);
    res.json(rows.map(mapEscalation));
  }),
);

/** Raise an escalation. The level is one above the highest still open (1 when none is). */
followupRouter.post(
  '/tasks/:taskId/escalations',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const task = await taskInfo(taskId);
    await assertCanEscalate(req, task.projectId, taskId, 'Only the PMO, the project owner and the person the task is given to can escalate it.');
    if (task.kind === 'summary') throw new HttpError(400, 'Escalate a task or milestone, not a phase.');
    const note = optStr(req.body?.note, 'Note', 1000);
    // The next step of the ladder: one above the highest still open.
    const { rows: open } = await db.query('SELECT COALESCE(MAX([level]), 0) AS n FROM escalations WHERE task_id = $1 AND resolved_at IS NULL', [taskId]);
    // The PMO may send it straight to a higher step (a meeting decides it goes to the executives, say).
    const asked = req.body?.level === undefined || req.body?.level === null ? null : Number(req.body.level);
    const steps = await ladder(db, taskId);
    if (open[0].n >= TOP) throw new HttpError(400, 'This is already escalated to the CEO.');
    let level: number = nextStep(steps, open[0].n)!.level;
    if (asked !== null) {
      if (!can(req, 'projects.edit_all')) throw new HttpError(403, 'Only the PMO sends an escalation straight to a higher step.');
      if (!Number.isInteger(asked) || asked <= open[0].n || asked > TOP) throw new HttpError(400, `Choose a step from ${open[0].n + 1} to ${TOP}.`);
      level = asked;
    }
    if (level > 1 && !(await canGovernProject(req, task.projectId))) {
      throw new HttpError(403, 'It is already with the project manager. They raise it further if it needs to go higher.');
    }
    const step = steps[level - 1];
    const toName = step.name;
    const { rows } = await db.query(
      `INSERT INTO escalations (task_id, [level], raised_by, to_name, note) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5)`,
      [taskId, level, req.user!.id, toName, note],
    );
    await logActivity(db, task.projectId, req.user!.id, 'escalation.raised', { taskId, name: task.name, level: rows[0].level, to: toName });
    // The person it goes to (when the name is clearly one account) and whoever decides for the project.
    await notify(db, [...step.userIds, ...(await deciders(db, task.projectId))], {
      kind: 'escalation.raised',
      projectId: task.projectId,
      taskId,
      data: { name: task.name, level: rows[0].level, to: toName, note, by: req.user!.name },
    }, req.user!.id);
    res.status(201).json(mapEscalation(rows[0]));
  }),
);

followupRouter.post(
  '/escalations/:id/resolve',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const { rows } = await db.query('SELECT * FROM escalations WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'Escalation not found.');
    const task = await taskInfo(rows[0].task_id);
    await assertCanEscalate(req, task.projectId, rows[0].task_id, 'Only the PMO, the project owner and the person the task is given to can close an escalation.');
    if (rows[0].resolved_at) throw new HttpError(409, 'This escalation is already closed.');
    // Closing closes the whole line on this milestone: a lower step left open would climb straight back up.
    const { rows: closed } = await db.query('UPDATE escalations SET resolved_at = SYSDATETIMEOFFSET(), resolved_by = $2 OUTPUT INSERTED.* WHERE task_id = $1 AND resolved_at IS NULL', [rows[0].task_id, req.user!.id]);
    const done = closed.filter((e) => e.id === id);
    await logActivity(db, task.projectId, req.user!.id, 'escalation.resolved', { taskId: rows[0].task_id, name: task.name, level: rows[0].level, closed: closed.length });
    res.json(mapEscalation(done[0]));
  }),
);

/** Runs the automatic climb now (the PMO; tests pass a date to stand in for today). */
followupRouter.post(
  '/escalations/climb',
  requirePermission('projects.edit_all'),
  route(async (req, res) => {
    res.json(await climbEscalations(optDate(req.body?.today, 'Today') ?? undefined));
  }),
);
