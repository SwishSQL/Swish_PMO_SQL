import { db } from './db';
import { addDays, todayIso } from '../shared/dates';
import type { PersonInsight } from '../shared/types';

// Engagement & delivery insights: how each person works with the system, from what it records (never a personality
// judgement). The PMO sees all of it; each person sees one indicator and one tip. Counted only for people who can
// use the system (invited or signed in), over a period (90 days by default), and shown only with enough items.

export const MIN_ITEMS = 5;
const clamp = (n: number, a = 0, b = 100) => Math.max(a, Math.min(b, n));

export async function insights(o: { days?: number; userId?: number } = {}): Promise<PersonInsight[]> {
  const today = todayIso();
  const from = addDays(today, -(o.days ?? 90));
  const { rows: people } = await db.query(
    `SELECT u.id, u.name, u.title, u.department_id, d.name AS dept
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.active = 1 AND (u.setup_emailed_at IS NOT NULL OR u.password_hash IS NOT NULL) AND ($1 IS NULL OR u.id = $1)`,
    [o.userId ?? null],
  );
  if (!people.length) return [];
  const ids = people.map((p) => p.id);
  // Milestones given to them that were due in the period.
  const { rows: ms } = await db.query(
    `SELECT t.id, t.assignee_id, CONVERT(CHAR(10), t.end_date, 23) AS due, t.status,
            (SELECT CONVERT(CHAR(10), MIN(CAST(m.created_at AT TIME ZONE 'Arab Standard Time' AS DATE)), 23) FROM milestone_updates m WHERE m.task_id = t.id AND m.status = 'done') AS done_on,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM milestone_updates m WHERE m.task_id = t.id AND m.author_id = t.assignee_id AND CAST(m.created_at AT TIME ZONE 'Arab Standard Time' AS DATE) <= t.end_date) THEN 1 ELSE 0 END AS BIT) AS updated_in_time,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM task_dependencies x WHERE x.predecessor_id = t.id) THEN 1 ELSE 0 END AS BIT) AS has_successor
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.kind = 'milestone' AND t.system_key IS NULL AND t.status <> 'cancelled' AND t.not_required = 0 AND p.archived = 0
        AND t.assignee_id IN (SELECT CAST(value AS INT) FROM OPENJSON($1)) AND t.end_date >= $2 AND t.end_date <= $3`,
    [ids, from, today],
  );
  // Reminders and escalations that reached them about a milestone, and how long until they answered (an update).
  const { rows: asks } = await db.query(
    `SELECT n.user_id,
            CAST(DATEDIFF(SECOND, n.created_at, COALESCE((SELECT MIN(m.created_at) FROM milestone_updates m WHERE m.task_id = n.task_id AND m.author_id = n.user_id AND m.created_at > n.created_at),
              CASE WHEN SYSDATETIMEOFFSET() < DATEADD(DAY, 7, n.created_at) THEN SYSDATETIMEOFFSET() ELSE DATEADD(DAY, 7, n.created_at) END)) AS FLOAT) / 86400 AS days
       FROM notifications n
      WHERE n.user_id IN (SELECT CAST(value AS INT) FROM OPENJSON($1)) AND n.task_id IS NOT NULL AND n.kind IN ('escalation.raised', 'ai.reminder', 'mention')
        AND n.created_at >= CAST($2 AS DATE)`,
    [ids, from],
  );
  const { rows: load } = await db.query(
    `SELECT t.assignee_id, COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.kind = 'milestone' AND t.status NOT IN ('done', 'cancelled') AND p.archived = 0 AND p.health <> 'done' AND t.assignee_id IN (SELECT CAST(value AS INT) FROM OPENJSON($1))
      GROUP BY t.assignee_id`,
    [ids],
  );
  return people.map((p) => {
    const mine = ms.filter((m) => m.assignee_id === p.id);
    const items = mine.length;
    const onTime = mine.filter((m) => m.done_on && m.done_on <= m.due).length;
    const updated = mine.filter((m) => m.updated_in_time).length;
    const late = mine.map((m) => {
      const end = m.done_on ?? (m.status === 'done' ? m.due : today);
      return Math.max(0, Math.round((Date.parse(end) - Date.parse(m.due)) / 86_400_000));
    });
    const delayCaused = mine.reduce((n, m, i) => n + (m.has_successor ? Math.min(30, late[i]) : 0), 0);
    const replies = asks.filter((a) => a.user_id === p.id).map((a) => Number(a.days));
    const replyDays = replies.length ? Math.round((replies.reduce((a, b) => a + b, 0) / replies.length) * 10) / 10 : null;
    const pOn = items ? (onTime / items) * 100 : 0;
    const pUp = items ? (updated / items) * 100 : 0;
    const sReply = replyDays === null ? 70 : clamp(100 - ((replyDays - 1) / 4) * 100);
    const sDelay = clamp(100 - (delayCaused / 20) * 100);
    const score = Math.round(pOn * 0.4 + pUp * 0.3 + sReply * 0.2 + sDelay * 0.1);
    const parts: [PersonInsight['tip'], number][] = [
      ['deadlines', pOn],
      ['updates', pUp],
      ['replies', sReply],
      ['dependencies', sDelay],
    ];
    const weakest = parts.sort((a, b) => a[1] - b[1])[0];
    const label: PersonInsight['label'] = items < MIN_ITEMS ? 'not_enough' : score >= 75 ? 'strong' : score >= 50 ? 'on_track' : 'attention';
    return {
      userId: p.id,
      name: p.name,
      title: p.title,
      department: p.dept,
      load: load.find((l) => l.assignee_id === p.id)?.n ?? 0,
      items,
      onTimePct: Math.round(pOn),
      updatesOnTimePct: Math.round(pUp),
      replyDays,
      delayCausedDays: delayCaused,
      score: items < MIN_ITEMS ? null : score,
      label,
      tip: label === 'strong' || label === 'not_enough' ? null : weakest[0],
      summary:
        items < MIN_ITEMS
          ? `Not enough yet: ${items} milestone${items === 1 ? '' : 's'} due in the period (${MIN_ITEMS} needed).`
          : `${onTime} of ${items} milestones delivered on time; ${updated} updated before their date${replyDays !== null ? `; answers reminders in ${replyDays} days on average` : ''}${delayCaused ? `; ${delayCaused} days of delay passed on to dependent milestones` : ''}.`,
    };
  });
}

/** Strong or on track: one reminder is enough. Otherwise (or without enough data yet) the full set. */
export async function reliable(userId: number): Promise<boolean> {
  const [me] = await insights({ userId });
  return me?.label === 'strong' || me?.label === 'on_track';
}
