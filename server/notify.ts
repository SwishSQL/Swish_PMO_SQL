// In-app notifications. Events write them as they happen (a date change to decide, a decision, an
// escalation, a new owner or team member); reminders are made the first time a person checks in on a
// given day or week, so there is no scheduler to run. Work given to someone (a project, a task) is also
// emailed, when mail is set up and the person has not switched it off.

import type { Queryable } from './db';
import { db } from './db';
import { appBase, assignmentEmail, eventEmail, mailEnabled, sendMail } from './mail';
import { buildMatcher } from './people';
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
  | 'change.pending'
  | 'change.decided'
  | 'closure.requested'
  | 'closure.decided'
  | 'reminder.daily'
  | 'reminder.weekly';

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
    const { rows: people } = await db.query('SELECT id, name, email FROM users WHERE id IN (SELECT CAST(value AS INT) FROM OPENJSON($1)) AND active = 1 AND email_notifications = 1', [ids]);
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
        await sendMail(p.email, mail.subject, mail.text, mail.html);
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
 * once a week, on the reminder day (Wednesday, 8:00 Kuwait time; WEEKLY_REMINDER_DAY changes the day, 0 = Sunday).
 * One row in email_sent per person and week makes it once only, even across restarts and several servers.
 */
export async function sendWeeklyReminders(now = new Date()): Promise<number> {
  if (!mailEnabled()) return 0;
  const today = todayIso();
  const kuwait = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuwait', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(kuwait.find((x) => x.type === 'hour')?.value ?? 0);
  const dayName = kuwait.find((x) => x.type === 'weekday')?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayName);
  const wanted = Number(process.env.WEEKLY_REMINDER_DAY ?? 3);
  if (weekday !== wanted || hour < 8) return 0;
  const week = weekStart(today);
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, STRING_AGG(p.code, ',') WITHIN GROUP (ORDER BY p.code) AS codes
       FROM projects p JOIN users u ON u.id = p.manager_id
      WHERE u.active = 1 AND u.email_notifications = 1 AND p.archived = 0 AND p.health <> 'done' AND p.stage <> 'closed' AND p.start_date <= $1
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
    const mail = eventEmail('reminder.weekly', { who: u.name, by: '', project: '', code: '', name: '', from: '', to: '', reason: '', note: '', codes: String(u.codes).split(',').join(', '), delivery: '', url: base ? `${base}/#/updates` : '' });
    try {
      await sendMail(u.email, mail.subject, mail.text, mail.html);
      sent += 1;
    } catch (e) {
      // Let the next run try again.
      await db.query('DELETE FROM email_sent WHERE user_id = $1 AND [key] = $2', [u.id, `weekly:${week}`]);
      console.error(`[mail] could not send the weekly reminder to user ${u.id}: ${(e as Error).message}`);
    }
  }
  return sent;
}

/** Checks twice an hour whether it is time for the weekly reminders. */
export function startReminderJob(): void {
  if (process.env.NO_REMINDER_JOB === '1') return;
  const run = () => void sendWeeklyReminders().catch((e) => console.error(`[mail] weekly reminders failed: ${(e as Error).message}`));
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
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1 AND r.permissions LIKE N'%projects.approve_close%'`,
  );
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
      WHERE p.manager_id = $1 AND p.archived = 0 AND p.health <> 'done' AND p.stage <> 'closed' AND p.start_date <= $2
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
