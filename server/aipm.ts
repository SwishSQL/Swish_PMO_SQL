import { db } from './db';
import { loadCalendar } from './calendar';
import { notify, deciders } from './notify';
import { ladder } from './escalation';
import { logActivity } from './service';
import { reliable } from './insights';
import { criticalPath } from '../shared/schedule';
import { addDays, todayIso } from '../shared/dates';
import { mailEnabled, sendMail, appBase } from './mail';
import { emailShell, paragraph, details } from './emailLayout';

// The AI project manager: switched on per project by its manager (or the PMO), it follows the team up every working
// day as far as it can, the right way:
//  - reminds each milestone owner: a reliable person once, on the day (only if they have not updated in a week);
//    anyone else, or anything on the critical path, two working days before, on the day and the working day after
//  - raises an escalation (step 1, the project manager) on a milestone two working days late with no update since
//  - drafts the weekly update on Thursdays for the manager to review
//  - sends the manager a digest of what it did
// It never records progress itself (only what people post or reply), never approves or changes the plan, skips
// people on leave or paused by the PMO, writes at most 2 reminders a person a day, and logs everything it does.

const MAX_PER_DAY = 2;
const kuwait = (now: Date) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuwait', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(now);
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? ''), hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0) };
};

async function log(projectId: number, action: string, message: string, taskId: number | null = null, userId: number | null = null) {
  await db.query('INSERT INTO ai_pm_log (project_id, task_id, user_id, action, message) VALUES ($1, $2, $3, $4, $5)', [projectId, taskId, userId, action, message]);
}

/** An email only where follow-up emails are allowed (live, or this person is live in test mode) and the person was invited. */
async function email(user: { email: string; invited: boolean }, subject: string, title: string, body: string, rows: [string, string][], projectId: number) {
  const testTo = (process.env.FOLLOWUP_TEST_TO ?? '').trim().toLowerCase();
  const live = (process.env.FOLLOWUP_LIVE_TO ?? '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = process.env.FOLLOWUP_ENABLED === '1' && !testTo ? true : live.includes(user.email.toLowerCase());
  if (!mailEnabled() || !allowed || !user.invited) return;
  const html = emailShell({ subject, title, subtitle: 'AI project manager', footer: 'You get this because a milestone is given to you in SWiSH PMO. Reply to post your update.', rows: [paragraph(body), details(rows)], button: appBase() ? { label: 'Open SWiSH PMO', url: `${appBase()}/#/projects/${projectId}/plan` } : undefined });
  const text = `${body}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nReply to this email with your update: it is posted on the milestone.`;
  await sendMail(user.email, subject, text, html, { ref: `p${projectId}` }).catch((e) => console.error(`[aipm] email failed: ${(e as Error).message}`));
}

export async function runAiPm(o: { now?: Date; force?: boolean; today?: string } = {}): Promise<{ reminders: number; escalations: number; drafts: number }> {
  const now = o.now ?? new Date();
  const today = o.today ?? todayIso();
  const cal = await loadCalendar(db);
  const out = { reminders: 0, escalations: 0, drafts: 0 };
  if (!o.force) {
    const k = kuwait(now);
    if (!cal.isWorkday(today) || k.hour < 8) return out;
    const { rows } = await db.query('INSERT INTO job_runs ([key]) OUTPUT INSERTED.[key] SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM job_runs WITH (UPDLOCK, HOLDLOCK) WHERE [key] = $1)', [`aipm:${today}`]);
    if (!rows.length) return out;
  }
  const { rows: projects } = await db.query(
    `SELECT p.id, p.code, p.name, p.manager_id FROM projects p
      WHERE p.ai_pm_enabled = 1 AND p.archived = 0 AND p.health <> 'done'
        AND NOT EXISTS (SELECT 1 FROM project_dependencies d JOIN projects o ON o.id = d.depends_on_id
                         WHERE d.project_id = p.id AND d.started_before = 0 AND o.health <> 'done' AND o.archived = 0)`,
  );
  const sentToday = new Map<number, number>();
  const { rows: already } = await db.query(`SELECT user_id, COUNT(*) AS n FROM ai_pm_log WHERE action = 'reminder' AND CAST(SWITCHOFFSET(created_at, '+00:00') AS DATE) = CAST($1 AS DATE) GROUP BY user_id`, [today]);
  for (const r of already) sentToday.set(r.user_id, r.n);
  const reliableCache = new Map<number, boolean>();
  for (const p of projects) {
    const did: string[] = [];
    const { rows: tasks } = await db.query('SELECT * FROM tasks WHERE project_id = $1', [p.id]);
    const { rows: deps } = await db.query('SELECT predecessor_id, successor_id, lag_days FROM task_dependencies WHERE predecessor_id IN (SELECT id FROM tasks WHERE project_id = $1)', [p.id]);
    let critical = new Set<number>();
    try {
      critical = criticalPath(
        tasks.map((t) => ({ id: t.id, parentId: t.parent_id, kind: t.kind, startDate: String(t.start_date).slice(0, 10), endDate: String(t.end_date).slice(0, 10) })) as any,
        deps.map((d) => ({ predecessorId: d.predecessor_id, successorId: d.successor_id, lagDays: d.lag_days })) as any,
      ).critical;
    } catch {
      /* no network: nothing is critical */
    }
    const { rows: open } = await db.query(
      `SELECT t.id, t.name, CONVERT(CHAR(10), t.end_date, 23) AS due, t.assignee_id, u.name AS owner, u.email, u.ai_paused, CONVERT(CHAR(10), u.away_until, 23) AS away_until,
              CAST(CASE WHEN u.setup_emailed_at IS NOT NULL OR u.password_hash IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS invited,
              (SELECT CONVERT(CHAR(10), MAX(CAST(m.created_at AT TIME ZONE 'Arab Standard Time' AS DATE)), 23) FROM milestone_updates m WHERE m.task_id = t.id) AS last_update,
              CAST(CASE WHEN EXISTS (SELECT 1 FROM escalations e WHERE e.task_id = t.id AND e.resolved_at IS NULL) THEN 1 ELSE 0 END AS BIT) AS escalated
         FROM tasks t JOIN users u ON u.id = t.assignee_id AND u.active = 1
        WHERE t.project_id = $1 AND t.kind = 'milestone' AND t.system_key IS NULL AND t.not_required = 0 AND t.status NOT IN ('done', 'cancelled')`,
      [p.id],
    );
    for (const m of open) {
      if (m.ai_paused || (m.away_until && m.away_until >= today)) continue;
      const before = m.due > today && cal.workdays(addDays(today, 1), m.due) === 2;
      const onDay = m.due === today;
      const after = m.due < today && cal.workdays(addDays(m.due, 1), today) === 1;
      if (!reliableCache.has(m.assignee_id)) reliableCache.set(m.assignee_id, await reliable(m.assignee_id));
      const full = critical.has(m.id) || !reliableCache.get(m.assignee_id);
      const quietWeek = !m.last_update || m.last_update < addDays(today, -7);
      const stage = onDay && (full || quietWeek) ? 'day' : full && before ? 'before' : full && after ? 'after' : null;
      if (stage && (sentToday.get(m.assignee_id) ?? 0) < MAX_PER_DAY) {
        // In T-SQL a "[" in a LIKE pattern opens a character class: escaped, so the tag is matched as written.
        const { rows: seen } = await db.query(`SELECT 1 FROM ai_pm_log WHERE task_id = $1 AND action = 'reminder' AND message LIKE $2 ESCAPE '\\'`, [m.id, `\\[${stage}:${m.due}]%`]);
        if (!seen.length) {
          const words = stage === 'before' ? `is due on ${m.due}` : stage === 'day' ? 'is due today' : `was due on ${m.due} and is not done`;
          await notify(db, [m.assignee_id], { kind: 'ai.reminder', projectId: p.id, taskId: m.id, data: { name: m.name, stage, due: m.due, project: `${p.code} ${p.name}` }, dedupe: `aipm:${m.id}:${stage}:${m.due}` });
          await email({ email: m.email, invited: m.invited }, `SWiSH PMO: "${m.name}" ${words}`, 'Your milestone', `Hello ${m.owner}, your milestone ${words}. Post an update, or reply to this email with where it stands.`, [['Milestone', m.name], ['Project', `${p.code} ${p.name}`], ['Due', m.due]], p.id);
          await log(p.id, 'reminder', `[${stage}:${m.due}] Reminded ${m.owner}: "${m.name}" ${words}${critical.has(m.id) ? ' (critical path)' : ''}.`, m.id, m.assignee_id);
          sentToday.set(m.assignee_id, (sentToday.get(m.assignee_id) ?? 0) + 1);
          out.reminders++;
          did.push(`reminded ${m.owner} about "${m.name}"`);
        }
      }
      // Two working days late, nothing posted since the date, no escalation open: raised to the project manager.
      const lateDays = m.due < today ? cal.workdays(addDays(m.due, 1), today) : 0;
      if (lateDays >= 2 && !m.escalated && (!m.last_update || m.last_update <= m.due)) {
        const steps = await ladder(db, m.id);
        const note = `Raised by the AI project manager: ${lateDays} working days late with no update since its date.`;
        await db.query('INSERT INTO escalations (task_id, level, raised_by, to_name, note) VALUES ($1, 1, NULL, $2, $3)', [m.id, steps[0].name, note]);
        await logActivity(db, p.id, null, 'escalation.raised', { taskId: m.id, name: m.name, level: 1, to: steps[0].name, by: 'AI project manager' });
        await notify(db, [...steps[0].userIds, ...(await deciders(db, p.id))], { kind: 'escalation.raised', projectId: p.id, taskId: m.id, data: { name: m.name, level: 1, to: steps[0].name, note, by: 'AI project manager' } });
        await log(p.id, 'escalation', `Escalated "${m.name}" to ${steps[0].name}: ${lateDays} working days late, no update.`, m.id, m.assignee_id);
        out.escalations++;
        did.push(`escalated "${m.name}"`);
      }
    }
    // Thursday: a draft of the weekly update for the manager.
    if (kuwait(now).weekday === 4 || o.force) {
      const { rows: week } = await db.query(
        `SELECT t.name, m.status, m.progress, m.comment, m.blocker FROM milestone_updates m JOIN tasks t ON t.id = m.task_id
          WHERE t.project_id = $1 AND m.created_at >= DATEADD(DAY, -7, SYSDATETIMEOFFSET()) ORDER BY m.created_at`,
        [p.id],
      );
      const done = week.filter((w) => w.status === 'done').map((w) => w.name);
      const blockers = week.filter((w) => w.blocker).map((w) => `${w.name}: ${w.blocker}`);
      const lateNow = open.filter((m) => m.due < today).map((m) => m.name);
      const draft = [
        `Accomplishments: ${done.length ? done.join('; ') : 'no milestone completed this week'}.`,
        `Updates: ${week.length} posted this week.`,
        `Blockers: ${blockers.length ? blockers.join('; ') : 'none reported'}.`,
        `Late: ${lateNow.length ? lateNow.join('; ') : 'nothing late'}.`,
      ].join('\n');
      const { rows: has } = await db.query(`SELECT 1 FROM ai_pm_log WHERE project_id = $1 AND action = 'weekly_draft' AND CAST(SWITCHOFFSET(created_at, '+00:00') AS DATE) = CAST($2 AS DATE)`, [p.id, today]);
      if (!has.length) {
        await log(p.id, 'weekly_draft', draft);
        out.drafts++;
        did.push('drafted the weekly update');
      }
    }
    if (did.length && p.manager_id) {
      await notify(db, [p.manager_id], { kind: 'ai.digest', projectId: p.id, data: { project: `${p.code} ${p.name}`, count: did.length, what: did.slice(0, 6).join('; ') }, dedupe: `aipm-digest:${p.id}:${today}` });
    }
  }
  if (out.reminders || out.escalations || out.drafts) console.log(`[aipm] ${out.reminders} reminders, ${out.escalations} escalations, ${out.drafts} drafts`);
  return out;
}
