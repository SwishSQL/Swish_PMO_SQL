import { db } from './db';
import type { Queryable } from './db';
import { closers, deciders, notify, userNamed } from './notify';
import { loadCalendar } from './calendar';
import { logActivity } from './service';
import { addDays, todayIso } from '../shared/dates';
import type { EscalationStep } from '../shared/types';

// The escalation ladder, the same on every project: 1 the project manager, 2 the program manager, 3 the portfolio
// manager, 4 the PMO, 5 IBE (Integrated Business Excellence), 6 the CEO. A step with nobody on it is skipped.
//
// An escalation nobody acts on climbs by itself. Acting is closing it or posting an update on the milestone.
// Counted in working days (no Friday, Saturday or official holiday): 2 at each step up to the PMO, 3 at IBE. At the
// CEO, the last step, a reminder after 3.

export const CLIMB_AFTER: Record<number, number> = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 3 };
export const CEO_REMIND_AFTER = 3;
export const TOP = 6;

/**
 * SQL (for a task aliased t): an escalation on it was closed on or after its current deadline. Closing means it was
 * dealt with for this deadline, so nothing raises it again automatically until the milestone has a new date.
 */
export const CLOSED_FOR_DEADLINE = `EXISTS (SELECT 1 FROM escalations ec WHERE ec.task_id = t.id AND ec.resolved_at IS NOT NULL
  AND CAST(ec.resolved_at AT TIME ZONE 'Arab Standard Time' AS DATE) >= t.end_date)`;

export async function ladder(q: Queryable, taskId: number): Promise<(EscalationStep & { userIds: number[] })[]> {
  const { rows } = await q.query(
    `SELECT p.manager_id, m.name AS manager_name,
            dm.manager_user_id AS program_id, pu.name AS program_name,
            c.manager_user_id AS portfolio_id, fu.name AS portfolio_name
       FROM tasks t JOIN projects p ON p.id = t.project_id
       LEFT JOIN users m ON m.id = p.manager_id AND m.active = 1
       LEFT JOIN initiatives i ON i.id = p.initiative_id
       LEFT JOIN dimensions dm ON dm.id = i.dimension_id
       LEFT JOIN users pu ON pu.id = dm.manager_user_id AND pu.active = 1
       LEFT JOIN capabilities c ON c.id = dm.capability_id
       LEFT JOIN users fu ON fu.id = c.manager_user_id AND fu.active = 1
      WHERE t.id = $1`,
    [taskId],
  );
  const r = rows[0] ?? {};
  const pmo = await closers(q);
  const { rows: top } = await q.query(`SELECT l.[key], u.id, u.name FROM ladder_roles l JOIN users u ON u.id = l.user_id AND u.active = 1`);
  const named = (key: string) => top.find((x) => x.key === key);
  const step = (level: EscalationStep['level'], role: EscalationStep['role'], name: string | null | undefined, ids: number[], fallback: string) => ({
    level,
    role,
    name: name ?? fallback,
    hasAccount: ids.length > 0,
    userIds: ids,
  });
  return [
    step(1, 'pm', r.manager_name, r.manager_name ? [r.manager_id] : [], 'Project manager'),
    step(2, 'program', r.program_name, r.program_name ? [r.program_id] : [], 'Program manager'),
    step(3, 'portfolio', r.portfolio_name, r.portfolio_name ? [r.portfolio_id] : [], 'Portfolio manager'),
    step(4, 'pmo', 'PMO', pmo, 'PMO'),
    step(5, 'ibe', named('ibe')?.name, named('ibe') ? [named('ibe').id] : [], 'IBE'),
    step(6, 'ceo', named('ceo')?.name, named('ceo') ? [named('ceo').id] : [], 'CEO'),
  ];
}

/** The next step above `from` that has someone on it (the top step when none has). */
export function nextStep<T extends { level: number; hasAccount: boolean }>(steps: T[], from: number): T | null {
  return steps.find((s) => s.level > from && s.hasAccount) ?? (from < TOP ? steps[TOP - 1] : null);
}

/**
 * One pass over the open escalations (the highest open level of each milestone): reminds or raises the next level
 * when nobody has acted for long enough. Safe to run often: a reminder is made once, and a raise starts a new wait.
 */
export async function climbEscalations(today = todayIso()): Promise<{ reminded: number; raised: number }> {
  const cal = await loadCalendar(db);
  const { rows } = await db.query(
    `SELECT x.id, x.task_id, x.[level], x.to_name, x.project_id, x.name, x.raised_on, x.acted_on FROM (
     SELECT e.id, e.task_id, e.[level], e.to_name, t.project_id, t.name,
            CONVERT(CHAR(10), CAST(e.raised_at AT TIME ZONE 'Arab Standard Time' AS DATE), 23) AS raised_on,
            (SELECT CONVERT(CHAR(10), MAX(CAST(u.created_at AT TIME ZONE 'Arab Standard Time' AS DATE)), 23) FROM milestone_updates u
              WHERE u.task_id = e.task_id AND u.created_at > e.raised_at) AS acted_on,
            ROW_NUMBER() OVER (PARTITION BY e.task_id ORDER BY e.[level] DESC, e.id DESC) AS rn
       FROM escalations e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
      WHERE e.resolved_at IS NULL AND p.archived = 0 AND p.health <> 'done' AND t.status NOT IN ('done', 'cancelled')) x
      WHERE x.rn = 1 ORDER BY x.task_id`,
  );
  let reminded = 0;
  let raised = 0;
  for (const e of rows) {
    // Working days gone since it was raised, or since the last update on the milestone.
    const since: string = e.acted_on && e.acted_on > e.raised_on ? e.acted_on : e.raised_on;
    if (since >= today) continue;
    const waited = cal.workdays(addDays(since, 1), today);
    const level = e.level as number;
    const steps = await ladder(db, e.task_id);
    if (level >= TOP) {
      if (waited >= CEO_REMIND_AFTER) {
        await notify(db, steps[TOP - 1].userIds, {
          kind: 'escalation.raised',
          projectId: e.project_id,
          taskId: e.task_id,
          data: { name: e.name, level, to: e.to_name, note: `Reminder: waiting for an answer for ${waited} working days.`, by: 'PMO assistant' },
          dedupe: `esc-remind:${e.id}`,
        });
        reminded += 1;
      }
      continue;
    }
    if (waited < (CLIMB_AFTER[level] ?? 2)) continue;
    const next = nextStep(steps, level);
    if (!next) continue;
    const note = `Raised automatically: no response in ${waited} working days at level ${level} (${e.to_name}).`;
    await db.tx(async (q) => {
      const { rows: made } = await q.query(
        'INSERT INTO escalations (task_id, [level], raised_by, to_name, note) OUTPUT INSERTED.[level] VALUES ($1, $2, NULL, $3, $4)',
        [e.task_id, next.level, next.name, note],
      );
      await logActivity(q, e.project_id, null, 'escalation.raised', { taskId: e.task_id, name: e.name, level: made[0].level, to: next.name, by: 'Automatic escalation' });
    });
    await notify(db, [...next.userIds, ...(await deciders(db, e.project_id))], {
      kind: 'escalation.raised',
      projectId: e.project_id,
      taskId: e.task_id,
      data: { name: e.name, level: next.level, to: next.name, note, by: 'Automatic escalation' },
    });
    raised += 1;
  }
  if (reminded || raised) console.log(`[escalation] ${reminded} reminders, ${raised} raised a level`);
  return { reminded, raised };
}
