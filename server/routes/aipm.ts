import { Router } from 'express';
import { db } from '../db';
import { HttpError, can, canGovernProject, route } from '../auth';
import { idParam } from '../validate';
import { logActivity } from '../service';
import { insights } from '../insights';
import { runAiPm } from '../aipm';
import type { AiPmEntry } from '../../shared/types';

export const aipmRouter = Router();

/** Switch the AI project manager on or off: the project's manager (or head) and the PMO. */
aipmRouter.put(
  '/projects/:id/ai-pm',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await canGovernProject(req, id))) throw new HttpError(403, 'Only the project manager or the PMO switches the AI project manager.');
    const on = req.body?.enabled === true;
    await db.query('UPDATE projects SET ai_pm_enabled = $2, ai_pm_since = CASE WHEN $2 = 1 THEN SYSDATETIMEOFFSET() ELSE NULL END, ai_pm_by = $3 WHERE id = $1', [id, on, req.user!.id]);
    await logActivity(db, id, req.user!.id, on ? 'ai_pm.on' : 'ai_pm.off', {});
    res.json({ enabled: on });
  }),
);

/** What it did on a project, newest first (whoever runs the project, and the PMO). */
aipmRouter.get(
  '/projects/:id/ai-pm',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await canGovernProject(req, id)) && !can(req, 'projects.view_all')) throw new HttpError(403, 'For the project manager and the PMO.');
    const { rows } = await db.query('SELECT TOP (60) id, task_id, action, message, created_at FROM ai_pm_log WHERE project_id = $1 ORDER BY created_at DESC, id DESC', [id]);
    res.json(rows.map((r): AiPmEntry => ({ id: r.id, taskId: r.task_id, action: r.action, message: r.message, createdAt: new Date(r.created_at).toISOString() })));
  }),
);

/** The PMO runs a pass now (tests pass a day to stand in for today). */
aipmRouter.post(
  '/ai-pm/run',
  route(async (req, res) => {
    if (!can(req, 'projects.edit_all')) throw new HttpError(403, 'The PMO runs it by hand.');
    res.json(await runAiPm({ force: true, today: typeof req.body?.today === 'string' ? req.body.today : undefined }));
  }),
);

/** Engagement & delivery insights: everyone, for the PMO only. */
aipmRouter.get(
  '/insights',
  route(async (req, res) => {
    if (!can(req, 'projects.edit_all')) throw new HttpError(403, 'Insights are for the PMO.');
    const days = Math.min(365, Math.max(30, Number(req.query.days) || 90));
    res.json(await insights({ days }));
  }),
);

/** My own indicator: the label and one tip, nothing else. */
aipmRouter.get(
  '/insights/me',
  route(async (req, res) => {
    const [me] = await insights({ userId: req.user!.id });
    res.json(me ? { label: me.label, tip: me.tip } : { label: 'not_enough', tip: null });
  }),
);
