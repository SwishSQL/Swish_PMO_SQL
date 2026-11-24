// In-app notifications. Events write them as they happen (a date change to decide, a decision, an
// escalation, a new owner or team member); reminders are made the first time a person checks in on a
// given day or week, so there is no scheduler to run. Work given to someone (a project, a task) is also
// emailed, when mail is set up and the person has not switched it off.

import type { Queryable } from './db';
import { db } from './db';
import { appBase, assignmentEmail, eventEmail, mailEnabled, sendMail, weeklyEmail } from './mail';
import { aiEnabled, draftDigest } from './ai';
import { briefingEmail } from './briefingEmail';
import type { BriefingData } from './briefingEmail';
import { buildMatcher } from './people';
import { runFollowups } from './followup';
import { refreshAllStatuses } from './service';
import { addDays, todayIso, weekStart } from '../shared/dates';
import { STALE_DAYS } from '../shared/health';

export type NotificationKind =
  | 'deadline.pending'
  | 'deadline.decided'
  | 'escalation.raised'
  | 'task.assigned'
  | 'team.added'
  | 'project.assigned'
  | 'project.owner'
  | 'project.plan_started'
  | 'change.pending'
  | 'change.decided'
  | 'closure.requested'
  | 'closure.decided'
  | 'reminder.daily'
  | 'reminder.weekly'
  | 'owner.requested'
  | 'owner.decided'
  | 'project.unblocked'
  | 'mention'
  | 'risk.assigned'
  | 'task.coowner'
  | 'meeting.owner'
  | 'plan.manager'
  | 'department.head'
  | 'ladder.role'
  | 'project.sponsor'
  | 'project.stakeholder'
  | 'ai.reminder'
  | 'ai.digest';

interface Note {
  kind: NotificationKind;
  projectId?: number | null;
  taskId?: number | null;
  data: Record<string, unknown>;
  /** One per person: a second note with the same key is skipped (daily and weekly reminders). */
  dedupe?: string;
}

/** Write one note for each person, never for the one who caused it. */
export async function notify(q: Queryable, userIds: (number | null | undefined)[], note: Note, actorId?: number | null): Promise<void> {
  const ids = [...new Set(userIds.filter((x): x is number => typeof x === 'number' && x !== actorId))];
  const fresh: number[] = [];
  for (const id of ids) {
    let rows: unknown[];
    try {
      ({ rows } = await q.query(
        `INSERT INTO notifications (user_id, kind, project_id, task_id, data, dedupe_key)
         OUTPUT INSERTED.id
         SELECT $1, $2, $3, $4, $5, $6
          WHERE $6 IS NULL OR NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = $1 AND dedupe_key = $6)`,
        [id, note.kind, note.projectId ?? null, note.taskId ?? null, JSON.stringify(note.data), note.dedupe ?? null],
      ));
    } catch (e) {
      // Two requests made the same reminder at once: the unique index let one through.
      if ((e as { code?: string }).code !== '23505') throw e;
      rows = [];
    }
    // Only a note that was really written is emailed: a skipped duplicate must not send a second email.
    if (rows.length) fresh.push(id);
  }
  if (fresh.length && EMAILED.has(note.kind)) void emailNote(fresh, note);
}

/** What is also sent by email: work given to someone, and what waits for their decision. */
const EMAILED = new Set<NotificationKind>(['task.assigned', 'project.owner', 'project.assigned', 'deadline.pending', 'closure.requested', 'change.pending']);

/**
 * Email the same news to the people who have not switched it off. It never holds up or fails the request that
 * caused it: a mail that cannot be sent is only logged, and the in-app notification is there anyway.
 */
async function emailNote(ids: number[], note: Note): Promise<void> {
  try {
    if (!mailEnabled()) return;
    const { rows: people } = await db.query(
      // Nobody is emailed about work before they were invited or signed in (accounts made ahead of launch).
      'SELECT id, name, email FROM users WHERE id IN (SELECT CAST(value AS INT) FROM OPENJSON($1)) AND active = 1 AND email_notifications = 1 AND (setup_emailed_at IS NOT NULL OR password_hash IS NOT NULL)', [ids]);
    if (!people.length) return;
    const { rows: pr } = note.projectId ? await db.query('SELECT code, name FROM projects WHERE id = $1', [note.projectId]) : { rows: [] as any[] };
    const base = appBase();
    const url = base && note.projectId ? `${base}/#/projects/${note.projectId}/${note.kind.startsWith('change.') ? 'changes' : `plan${note.taskId ? `?task=${note.taskId}` : ''}`}` : '';
    const d = note.data;
    for (const p of people) {
      const common = { who: p.name as string, by: String(d.by ?? ''), code: String(pr[0]?.code ?? ''), url };
      const mail =
        note.kind === 'deadline.pending' || note.kind === 'closure.requested' || note.kind === 'change.pending'
          ? eventEmail(note.kind, {
              ...common,
              // A closure note carries the project's name in "name"; a deadline note carries the task's.
              project: String(note.kind === 'closure.requested' ? (d.name ?? pr[0]?.name ?? '') : (d.project ?? pr[0]?.name ?? '')),
              name: String(d.name ?? ''),
              from: String(d.from ?? ''),
              to: String(d.to ?? ''),
              reason: String(d.reason ?? ''),
              note: String(d.note ?? ''),
              codes: String(d.code ?? ''),
              delivery: String(d.delivery ?? ''),
            })
          : assignmentEmail(note.kind as 'task.assigned' | 'project.owner' | 'project.assigned', {
              ...common,
              project: String(d.project ?? pr[0]?.name ?? ''),
              name: String(d.name ?? ''),
            });
      try {
        await sendMail(p.email, mail.subject, mail.text, mail.html, { ref: note.projectId ? `p${note.projectId}` : undefined });
      } catch (e) {
        console.error(`[mail] could not send the ${note.kind} email to user ${p.id}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    console.error(`[mail] ${note.kind} emails failed: ${(e as Error).message}`);
  }
}

/**
 * The weekly reminder by email: to each project manager who still owes the update for the week that has started,
 * once a week, on the reminder day (Sunday, 10:00 Kuwait time; WEEKLY_REMINDER_DAY changes the day, 0 = Sunday,
 * and WEEKLY_REMINDER_HOUR the hour).
 * One row in email_sent per person and week makes it once only, even across restarts and several servers.
 */
export async function sendWeeklyReminders(now = new Date()): Promise<number> {
  if (!mailEnabled()) return 0;
  const today = todayIso();
  const kuwait = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuwait', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(kuwait.find((x) => x.type === 'hour')?.value ?? 0);
  const dayName = kuwait.find((x) => x.type === 'weekday')?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayName);
  const wanted = Number(process.env.WEEKLY_REMINDER_DAY ?? 0);
  const from = Number(process.env.WEEKLY_REMINDER_HOUR ?? 10);
  if (weekday !== wanted || hour < from) return 0;
  const week = weekStart(today);
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, STRING_AGG(p.code, ',') WITHIN GROUP (ORDER BY p.code) AS codes
       FROM projects p JOIN users u ON u.id = p.manager_id
      WHERE u.active = 1 AND u.email_notifications = 1 AND (u.setup_emailed_at IS NOT NULL OR u.password_hash IS NOT NULL) AND p.archived = 0 AND p.health <> 'done' AND p.start_date <= $1
        AND NOT EXISTS (SELECT 1 FROM status_updates s WHERE s.project_id = p.id AND s.week_start = $1)
      GROUP BY u.id, u.name, u.email`,
    [week],
  );
  let sent = 0;
  for (const u of rows) {
    let mine: unknown[];
    try {
      ({ rows: mine } = await db.query(
        'INSERT INTO email_sent (user_id, [key]) OUTPUT INSERTED.user_id SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM email_sent WHERE user_id = $1 AND [key] = $2)',
        [u.id, `weekly:${week}`],
      ));
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      mine = [];
    }
    if (!mine.length) continue;
    const base = appBase();
    const mail = weeklyEmail({ who: u.name, codes: String(u.codes).split(',').join(', '), url: base ? `${base}/#/updates` : '' }, await digestFor(u.id, today, week));
    try {
      await sendMail(u.email, mail.subject, mail.text, mail.html);
      sent += 1;
    } catch (e) {
      // Let the next run try again.
      await db.query('DELETE FROM email_sent WHERE user_id = $1 AND [key] = $2', [u.id, `weekly:${week}`]);
      console.error(`[mail] could not send the weekly reminder to user ${u.id}: ${(e as Error).message}`);
    }
  }
  return sent + (await sendPortfolioBriefings(today, week));
}

/**
 * The briefing on every active project, for the PMO: to the system users listed in PMO_BRIEFING_TO (emails,
 * comma-separated), at the same time as the reminders, once a week. Needs the assistant: without it, none is sent.
 */
async function sendPortfolioBriefings(today: string, week: string): Promise<number> {
  const list = (process.env.PMO_BRIEFING_TO ?? '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return 0;
  const { rows } = await db.query('SELECT id, name, email FROM users WHERE active = 1 AND LOWER(email) IN (SELECT value FROM OPENJSON($1))', [list]);
  let brief: Awaited<ReturnType<typeof digestFor>> | undefined;
  let sent = 0;
  for (const u of rows) {
    const key = `pmo:${week}`;
    let mine: unknown[];
    try {
      ({ rows: mine } = await db.query(
        'INSERT INTO email_sent (user_id, [key]) OUTPUT INSERTED.user_id SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM email_sent WHERE user_id = $1 AND [key] = $2)',
        [u.id, key],
      ));
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      mine = [];
    }
    if (!mine.length) continue;
    brief ??= await digestFor(null, today, week);
    try {
      if (!brief) throw new Error('no briefing (the assistant is off, failed, or no project is active)');
      const mail = briefingEmail({ ...brief, who: u.name, url: appBase() });
      await sendMail(u.email, mail.subject, mail.text, mail.html);
      sent += 1;
    } catch (e) {
      await db.query('DELETE FROM email_sent WHERE user_id = $1 AND [key] = $2', [u.id, key]);
      console.error(`[mail] could not send the portfolio briefing to user ${u.id}: ${(e as Error).message}`);
    }
  }
  return sent;
}

/**
 * The briefing for a manager's weekly reminder (AI summary, numbers, projects, what is due), or null when the
 * assistant is off (no key, or AI_DIGEST=0), the manager has nothing open, or the model fails: then the plain
 * reminder goes out, never later and never not at all. A null userId is every active project (the PMO's briefing).
 */
export async function digestFor(userId: number | null, today: string, week: string): Promise<Omit<BriefingData, 'who' | 'url' | 'updateDue'> | null> {
  if (!aiEnabled() || process.env.AI_DIGEST === '0') return null;
  try {
    const { rows: projects } = await db.query(
      `SELECT TOP (${userId === null ? 40 : 20}) p.id, p.code, p.name, p.health, p.progress, CONVERT(CHAR(10), p.end_date, 23) AS end_date,
              CAST(CASE WHEN NOT EXISTS (SELECT 1 FROM status_updates s WHERE s.project_id = p.id AND s.week_start = $2) THEN 1 ELSE 0 END AS BIT) AS update_due
         FROM projects p
        WHERE ($1 IS NULL OR p.manager_id = $1) AND p.archived = 0 AND p.health <> 'done' AND p.start_date <= $3
        ORDER BY p.code`,
      [userId, week, today],
    );
    if (!projects.length) return null;
    const { rows: tasks } = await db.query(
      `SELECT TOP (2000) project_id, name, status, progress, CONVERT(CHAR(10), end_date, 23) AS due, COALESCE(blocker, '') AS blocker
         FROM tasks WHERE project_id IN (SELECT CAST(value AS INT) FROM OPENJSON($1)) AND kind <> 'summary' AND status <> 'cancelled'
        ORDER BY end_date`,
      [projects.map((p) => p.id)],
    );
    const horizon = addDays(today, 14);
    const per = projects.map((p) => {
      const mine = tasks.filter((t) => t.project_id === p.id);
      const open = mine.filter((t) => t.status !== 'done');
      return {
        p,
        done: mine.length - open.length,
        open,
        overdue: open.filter((t) => t.due < today),
        blocked: open.filter((t) => t.status === 'blocked' || t.blocker),
        upcoming: open.filter((t) => t.due >= today && t.due <= horizon),
      };
    });
    const digest = await draftDigest({
      today,
      projects: per.map((x) => ({
        code: x.p.code,
        name: x.p.name,
        health: x.p.health,
        progress: x.p.progress,
        endDate: x.p.end_date,
        updateDue: x.p.update_due,
        overdue: x.overdue.slice(0, 10).map((t) => ({ task: t.name, due: t.due, progress: t.progress })),
        blocked: x.blocked.slice(0, 10).map((t) => ({ task: t.name, blocker: String(t.blocker).slice(0, 300) })),
        upcoming: x.upcoming.slice(0, 10).map((t) => ({ task: t.name, due: t.due, progress: t.progress })),
      })),
    });
    const daysLeft = (iso: string) => Math.round((Date.parse(iso) - Date.parse(today)) / 86_400_000);
    return {
      dateLabel: new Date(`${today}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
      summary: digest.summary,
      priorities: digest.priorities,
      projects: per.map((x) => ({
        code: x.p.code,
        name: x.p.name,
        health: x.p.health,
        progress: x.p.progress,
        endDate: x.p.end_date,
        done: x.done,
        open: x.open.length,
        overdue: x.overdue.length,
        blocked: x.blocked.length,
      })),
      upcoming: per
        .flatMap((x) => [...x.overdue, ...x.upcoming].map((t) => ({ code: x.p.code as string, task: t.name as string, due: t.due as string, daysLeft: daysLeft(t.due) })))
        .sort((a, b) => a.due.localeCompare(b.due)),
    };
  } catch (e) {
    console.error(`[mail] weekly briefing for ${userId === null ? 'the PMO' : `user ${userId}`} failed: ${(e as Error).message}`);
    return null;
  }
}
/** Checks twice an hour whether it is time for the weekly reminders. */
export function startReminderJob(): void {
  if (process.env.NO_REMINDER_JOB === '1') return;
  const run = () => {
    void sendWeeklyReminders().catch((e) => console.error(`[mail] weekly reminders failed: ${(e as Error).message}`));
    void runFollowups().catch((e) => console.error(`[followup] the daily follow-up failed: ${(e as Error).message}`));
    void refreshAllStatuses().catch((e) => console.error(`[status] refreshing project health and stage failed: ${(e as Error).message}`));
    void import('./aipm')
      .then((m) => m.runAiPm())
      .catch((e) => console.error(`[aipm] the AI project manager failed: ${(e as Error).message}`));
    void import('./escalation')
      .then((m) => m.climbEscalations())
      .catch((e) => console.error(`[escalation] the automatic climb failed: ${(e as Error).message}`));
  };
  setTimeout(run, 60_000);
  setInterval(run, 30 * 60_000).unref();
}

/** Who decides for a project: its manager, or every active PMO account when it has none. */
export async function deciders(q: Queryable, projectId: number): Promise<number[]> {
  const { rows } = await q.query(
    `SELECT u.id FROM projects p JOIN users u ON u.id = p.manager_id WHERE p.id = $1 AND u.active = 1`,
    [projectId],
  );
  if (rows[0]) return [rows[0].id];
  // No owner: the head of the department decides, and failing that the PMO.
  const { rows: head } = await q.query(
    `SELECT u.id FROM projects p JOIN departments d ON d.id = p.department_id JOIN users u ON u.id = d.head_user_id WHERE p.id = $1 AND u.active = 1`,
    [projectId],
  );
  if (head[0]) return [head[0].id];
  const { rows: pmo } = await q.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1 AND r.permissions LIKE N'%projects.edit_all%'`,
  );
  return pmo.map((r) => r.id);
}

/** The accounts that may approve closing a project: the roles holding that permission. */
export async function closers(q: Queryable): Promise<number[]> {
  const { rows } = await q.query(
    // The PMO: approves closures and runs every project. Owners and executives may close too, but are not asked.
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.active = 1 AND r.permissions LIKE N'%projects.approve_close%' AND r.permissions LIKE N'%projects.edit_all%'`,
  );
  return rows.map((r) => r.id);
}

/** The active accounts named in a list of full names (a sponsor, stakeholders), matched exactly, any case. */
export async function accountsNamed(q: Queryable, names: (string | null | undefined)[]): Promise<number[]> {
  const want = [...new Set(names.map((n) => String(n ?? '').trim().toLowerCase()).filter(Boolean))];
  if (!want.length) return [];
  const { rows } = await q.query('SELECT id FROM users WHERE active = 1 AND LOWER(name) IN (SELECT value FROM OPENJSON($1))', [want]);
  return rows.map((r) => r.id);
}

/** The account a free-text name (an "escalate to" field) points at, when it clearly points at one. */
export async function userNamed(q: Queryable, name: string | null): Promise<number | null> {
  if (!name) return null;
  const { rows } = await q.query('SELECT id, name FROM users WHERE active = 1');
  return buildMatcher(rows)(name);
}

/**
 * Today's reminder about the person's own milestones, and this week's about weekly updates they owe,
 * each made once. Called when the person checks their notifications.
 */
export async function ensureReminders(userId: number): Promise<void> {
  const today = todayIso();
  const { rows } = await db.query(
    `SELECT t.end_date, t.last_update_on FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.kind <> 'summary' AND t.status NOT IN ('done','cancelled') AND p.archived = 0
        AND (t.assignee_id = $1 OR EXISTS (SELECT 1 FROM task_coowners c WHERE c.task_id = t.id AND c.user_id = $1))`,
    [userId],
  );
  const overdue = rows.filter((r) => r.end_date < today).length;
  const soon = rows.filter((r) => r.end_date >= today && r.end_date <= addDays(today, 2)).length;
  const stale = rows.filter((r) => !r.last_update_on || r.last_update_on < addDays(today, -STALE_DAYS)).length;
  if (overdue + soon + stale > 0) {
    await notify(db, [userId], { kind: 'reminder.daily', data: { overdue, soon, stale, day: today }, dedupe: `daily:${today}` });
  }

  // Weekly updates the person owes as project manager for the week that has started.
  const week = weekStart(today);
  const { rows: owed } = await db.query(
    `SELECT p.id, p.code FROM projects p
      WHERE p.manager_id = $1 AND p.archived = 0 AND p.health <> 'done' AND p.start_date <= $2
        AND NOT EXISTS (SELECT 1 FROM status_updates s WHERE s.project_id = p.id AND s.week_start = $2)
      ORDER BY p.code`,
    [userId, week],
  );
  if (owed.length) {
    await notify(db, [userId], {
      kind: 'reminder.weekly',
      data: { week, codes: owed.map((r) => r.code), count: owed.length },
      dedupe: `weekly:${week}`,
    });
  }
}
