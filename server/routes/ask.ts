import { Router } from 'express';
import { db } from '../db';
import { HttpError, route, seesAllProjects } from '../auth';
import { aiEnabled, cleanMessages } from '../ai';
import { askPortfolio } from '../ask';
import type { PortfolioSnapshot } from '../ask';
import { orgContext } from './staff';
import { spend } from './ai';
import { listProjects } from '../service';
import { projectVisibleSql, taskVisibleSql } from '../visibility';
import { todayIso } from '../../shared/dates';

export const askRouter = Router();

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * A question about the portfolio, answered from a snapshot of the projects this person can see (and, inside them,
 * the tasks they can see). Read only. Body: { messages: [{role, content}...] }. Returns { answer, projectIds }.
 * What goes to the model: project names and codes, departments, owners' names, dates, health, and for the tasks that
 * are late or blocked their names, owners, blockers, latest comments and the reason of their last deadline move.
 */
askRouter.post(
  '/ai/ask',
  route(async (req, res) => {
    if (!aiEnabled()) throw new HttpError(503, 'The assistant is not switched on.');
    const messages = cleanMessages(req.body?.messages, 1500);
    spend(req.user!.id);
    const snapshot = await portfolioSnapshot(seesAllProjects(req) ? null : req.user!.id);
    const named = [...snapshot.projects.map((p) => p.owner), ...snapshot.problemTasks.map((t) => t.owner)].filter((x): x is string => Boolean(x));
    snapshot.org = await orgContext([...new Set(named)]);
    const out = await askPortfolio(messages, snapshot);
    const byId = new Map(snapshot.projects.map((p) => [p.id, p]));
    res.json({
      answer: out.answer,
      projects: out.projectIds.map((id) => ({ id, code: byId.get(id)!.code, name: byId.get(id)!.name })),
    });
  }),
);

/** The projects this person can see (null: all), and inside them the tasks they can see, as the model is given them. */
export async function portfolioSnapshot(visibleTo: number | null): Promise<PortfolioSnapshot> {
  const today = todayIso();
  const [list, { rows: deps }, { rows: tasks }, { rows: weekly }] = await Promise.all([
    listProjects(null, visibleTo),
    db.query('SELECT id, name FROM departments'),
    db.query(
      `SELECT TOP (220) t.id, t.project_id, t.name, CONVERT(CHAR(10), t.end_date, 23) AS due, DATEDIFF(DAY, t.end_date, CAST(SYSUTCDATETIME() AS DATE)) AS late_raw, t.status, t.progress,
              COALESCE(u.name, t.owner_name) AS owner, COALESCE(t.blocker, '') AS blocker, COALESCE(t.update_comment, '') AS comment,
              (SELECT TOP (1) CONVERT(CHAR(10), d.from_date, 23) AS [from], CONVERT(CHAR(10), d.to_date, 23) AS [to], d.reason
                 FROM deadline_changes d WHERE d.task_id = t.id AND d.status <> 'rejected' ORDER BY d.requested_at DESC FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS move__json
         FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id
        WHERE p.archived = 0 AND t.kind <> 'summary' AND t.status NOT IN ('done', 'cancelled')
          AND (t.end_date < $2 OR t.status = 'blocked' OR COALESCE(t.blocker, '') <> '')
          AND ${projectVisibleSql('p', '$1')} AND ${taskVisibleSql('t', 'p', '$1')}
        ORDER BY t.end_date`,
      [visibleTo, today],
    ),
    db.query(
      `SELECT x.project_id, x.[week], x.blockers, x.accomplishments FROM (
       SELECT s.project_id, CONVERT(CHAR(10), s.week_start, 23) AS [week], s.blockers, s.accomplishments,
              ROW_NUMBER() OVER (PARTITION BY s.project_id ORDER BY s.week_start DESC) AS rn
         FROM status_updates s JOIN projects p ON p.id = s.project_id
        WHERE ${projectVisibleSql('p', '$1')}) x WHERE x.rn = 1`,
      [visibleTo],
    ),
  ]);
  const deptName = new Map(deps.map((d) => [d.id as number, d.name as string]));
  const lastWeekly = new Map(weekly.map((w) => [w.project_id as number, w]));
  return {
    today,
    projects: list.slice(0, 150).map((p) => {
      const w = lastWeekly.get(p.id);
      const open = p.health !== 'done' && p.progress < 100;
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        department: deptName.get(p.departmentId) ?? '',
        owner: p.managerName,
        stage: p.stage,
        health: p.health,
        progress: p.progress,
        start: p.startDate,
        end: p.endDate,
        originalEnd: p.baselineEnd,
        daysLate: open && p.endDate < today ? daysBetween(today, p.endDate) : 0,
        openRisks: p.openRisks,
        lastWeeklyUpdate: w ? { week: w.week, blockers: clip(w.blockers, 250), accomplishments: clip(w.accomplishments, 200) } : null,
      };
    }),
    problemTasks: tasks.map((t) => ({
      projectId: t.project_id,
      task: clip(t.name, 120),
      due: t.due,
      daysLate: Math.max(0, Number(t.late_raw)),
      status: t.status,
      progress: t.progress,
      owner: t.owner ?? null,
      blocker: clip(t.blocker, 250),
      lastComment: clip(t.comment, 250),
      lastDeadlineMove: t.move ? { from: t.move.from, to: t.move.to, reason: clip(t.move.reason, 250) } : null,
    })),
  };
}
