import { Router } from 'express';
import { db } from '../db';
import { HttpError, can, canGovernProject, route } from '../auth';
import { loadCalendar } from '../calendar';
import { aiEnabled, aiVariables, cleanDraft, cleanMessages, draftProject, draftWeeklyUpdate } from '../ai';
import type { Context } from '../ai';
import { addDays, todayIso } from '../../shared/dates';
import { idParam } from '../validate';

export const aiRouter = Router();

// Each answer costs money, so each person gets a modest allowance: 20 requests in any 10 minutes.
const WINDOW_MS = 10 * 60_000;
const LIMIT = 20;
const used = new Map<number, number[]>();

export function spend(userId: number): void {
  const now = Date.now();
  const recent = (used.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) throw new HttpError(429, 'You have asked the assistant a lot in the last minutes. Wait a little, or use the form.');
  recent.push(now);
  used.set(userId, recent);
}

/** Whether the assistant is set up (an API key is present). The page hides the button when it is not. */
aiRouter.get(
  '/ai/status',
  route(async (req, res) => {
    const enabled = aiEnabled();
    // The PMO is told what the server does see, so a misspelt or empty variable is found at once.
    res.json({ enabled, variables: !enabled && can(req, 'projects.edit_all') ? aiVariables() : undefined });
  }),
);

/**
 * One turn of the chat. Body: { messages: [{role, content}...], draft? } where draft is the current draft as
 * the person has it on screen. Returns { reply, assumptions, draft, missing }. Nothing is created here.
 */
aiRouter.post(
  '/ai/project-draft',
  route(async (req, res) => {
    if (!aiEnabled()) throw new HttpError(503, 'The assistant is not switched on. Use the form to start a project.');
    // The departments this person may start a project in: the same rule as creating one by hand.
    const { rows: deps } = await db.query('SELECT id, name, name_ar, head_user_id FROM departments ORDER BY color_slot, name');
    const all = can(req, 'projects.edit_all') || can(req, 'projects.assign');
    const allowed = deps
      .filter((d) => all || (can(req, 'projects.create') && d.head_user_id === req.user!.id))
      .map((d) => ({ id: d.id as number, name: d.name as string, nameAr: (d.name_ar as string) ?? '' }));
    if (allowed.length === 0) {
      throw new HttpError(403, 'Only the head of a department starts a project, in their own department. Ask the department head, or the company owner.');
    }
    // A pasted plan can be long: 20000 characters is a few hundred rows.
    const messages = cleanMessages(req.body?.messages, 20000);
    spend(req.user!.id);

    const today = todayIso();
    const [{ rows: people }, { rows: q }, calendar] = await Promise.all([
      db.query('SELECT TOP (400) id, name FROM users WHERE active = 1 ORDER BY name'),
      db.query('SELECT TOP (1) code, starts_on, ends_on FROM quarters WHERE starts_on <= $1 AND ends_on >= $1 ORDER BY starts_on', [today]),
      loadCalendar(db),
    ]);
    const ctx: Context = {
      today,
      quarter: q[0] ? { code: q[0].code, startsOn: q[0].starts_on, endsOn: q[0].ends_on } : null,
      departments: allowed,
      people: people.map((p) => ({ id: p.id as number, name: p.name as string })),
      calendar,
    };
    // The draft on screen goes through the same clean-up as the model's: it came from a browser.
    const current = req.body?.draft ? cleanDraft(req.body.draft, ctx) : null;
    res.json(await draftProject(messages, current, ctx));
  }),
);

/**
 * The first draft of a project's weekly update, from what was reported on its milestones in the last seven days.
 * Same rule as filing the update: the project's manager (or head, or the PMO). Only the project's name, task names
 * with their dates, statuses, comments and blockers go to the model: no people, no emails. Nothing is saved.
 */
aiRouter.post(
  '/ai/weekly-draft/:id',
  route(async (req, res) => {
    if (!aiEnabled()) throw new HttpError(503, 'The assistant is not switched on.');
    const id = idParam(req.params.id);
    if (!can(req, 'updates.write') && !can(req, 'projects.edit_all')) throw new HttpError(403, 'Your role does not allow filing weekly updates.');
    if (!(await canGovernProject(req, id))) throw new HttpError(403, 'Only the project manager or the PMO files the weekly update.');
    spend(req.user!.id);

    const today = todayIso();
    const [{ rows: pr }, { rows: reports }, { rows: open }] = await Promise.all([
      db.query('SELECT name, progress, health FROM projects WHERE id = $1', [id]),
      db.query(
        `SELECT TOP (80) t.name AS task, u.status, u.progress, COALESCE(u.comment, '') AS comment, COALESCE(u.blocker, '') AS blocker,
                CONVERT(CHAR(10), u.created_at AT TIME ZONE 'Arab Standard Time', 23) AS [on]
           FROM milestone_updates u JOIN tasks t ON t.id = u.task_id
          WHERE t.project_id = $1 AND t.kind <> 'summary' AND u.created_at >= DATEADD(DAY, -7, SYSDATETIMEOFFSET())
          ORDER BY u.created_at DESC, u.id DESC`,
        [id],
      ),
      db.query(
        `SELECT TOP (400) name, kind, status, progress, CONVERT(CHAR(10), end_date, 23) AS due, COALESCE(blocker, '') AS blocker
           FROM tasks WHERE project_id = $1 AND kind <> 'summary' AND status NOT IN ('done', 'cancelled')
          ORDER BY end_date`,
        [id],
      ),
    ]);
    if (!pr[0]) throw new HttpError(404, 'Project not found.');
    const horizon = addDays(today, 14);
    const draft = await draftWeeklyUpdate({
      project: pr[0].name,
      today,
      reports: reports.map((r) => ({ task: r.task, status: r.status, progress: r.progress, comment: String(r.comment).slice(0, 400), blocker: String(r.blocker).slice(0, 300), on: r.on })),
      overdue: open.filter((t) => t.due < today).slice(0, 30).map((t) => ({ task: t.name, due: t.due, progress: t.progress })),
      blocked: open.filter((t) => t.status === 'blocked' || t.blocker).slice(0, 30).map((t) => ({ task: t.name, blocker: String(t.blocker).slice(0, 300) })),
      upcoming: open.filter((t) => t.due >= today && t.due <= horizon).slice(0, 30).map((t) => ({ task: t.name, due: t.due, progress: t.progress })),
      planProgress: pr[0].progress,
      currentHealth: pr[0].health,
    });
    res.json({ ...draft, basedOn: reports.length });
  }),
);
