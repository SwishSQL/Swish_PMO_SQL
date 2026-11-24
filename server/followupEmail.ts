import { ACCENT, FONT, HEALTH, INK, LINE, MUTED, callout, emailShell, esc, paragraph, section } from './emailLayout';
import { fmtDate } from './briefingEmail';

// The daily follow-up: the milestones a person owns that are late, blocked, about to be missed or without news,
// grouped by project, with how to answer by replying. Same table layout as every other email (Outlook-safe).

export interface FollowupItem {
  projectCode: string;
  projectName: string;
  task: string;
  due: string;
  status: string;
  progress: number;
  /** Why it is asked about, in words: "3 days overdue", "Blocked: waiting for the vendor". */
  reason: string;
  tone: 'late' | 'blocked' | 'risk' | 'stale';
  /** How many follow-ups were sent about it before this one. */
  before: number;
  /** Set when the owner has no account and the project manager is asked instead. */
  ownerName?: string | null;
}

const TONE = { late: HEALTH.off_track, blocked: HEALTH.at_risk, risk: HEALTH.at_risk, stale: HEALTH.not_started };
const STATUS: Record<string, string> = { todo: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };
const nth = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

export function followupEmail(p: {
  who: string;
  dateLabel: string;
  intro: string;
  items: FollowupItem[];
  url: string;
  /** Test mode: who the email is really for; it is sent to the test address instead. */
  preview?: { name: string; email: string | null };
}): { subject: string; text: string; html: string } {
  const first = p.who.split(/\s+/)[0] || p.who;
  const late = p.items.filter((i) => i.tone === 'late').length;
  const n = p.items.length;
  const subject = `${p.preview ? `[TEST for ${p.preview.name}] ` : ''}SWiSH PMO: ${late ? `${late} overdue milestone${late === 1 ? '' : 's'}` : `${n} milestone${n === 1 ? '' : 's'}`} need${(late || n) === 1 ? 's' : ''} your update`;
  const groups = new Map<string, FollowupItem[]>();
  for (const i of p.items) groups.set(`${i.projectCode} ${i.projectName}`, [...(groups.get(`${i.projectCode} ${i.projectName}`) ?? []), i]);

  const rows = [...groups].map(([project, items]) =>
    section(
      project,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;border-collapse:separate">${items
        .map((i, k) => {
          const t = TONE[i.tone];
          const top = k ? `border-top:1px solid ${LINE};` : '';
          return `<tr><td width="4" style="${top}background:${t.color};font-size:0" bgcolor="${t.color}">&nbsp;</td><td style="${top}padding:12px 14px;${FONT};color:${INK}">
<div style="font-size:15px;font-weight:600;line-height:21px">${esc(i.task)}</div>
<div style="margin-top:4px;font-size:13px;color:${t.color};font-weight:700">${esc(i.reason)}${i.before ? `<span style="color:${MUTED};font-weight:400"> &nbsp;·&nbsp; ${nth(i.before + 1)} reminder</span>` : ''}</div>
<div style="margin-top:4px;font-size:12px;color:${MUTED}">Due ${esc(fmtDate(i.due))} &nbsp;·&nbsp; ${esc(STATUS[i.status] ?? i.status)} &nbsp;·&nbsp; ${i.progress}%${i.ownerName ? ` &nbsp;·&nbsp; Owner: ${esc(i.ownerName)} (no account yet)` : ''}</div>
</td></tr>`;
        })
        .join('')}</table>`,
    ),
  );
  const how = callout(
    `<b>Reply to this email with your update, in your own words.</b><br>For example: <i>"Installation is 80%, waiting for the vendor"</i>, <i>"Training is done"</i> or <i>"Go-live moves to 15 December because the contract is late"</i>. I will write back what I will change, and update the system once you agree.`,
    ACCENT,
    '#f0fdfa',
  );
  const html = emailShell({
    subject,
    title: 'Your daily follow-up',
    subtitle: p.dateLabel,
    preheader: p.intro,
    rows: [
      p.preview
        ? callout(`<b>Test mode.</b> This follow-up is for <b>${esc(p.preview.name)}</b> (${p.preview.email ? esc(p.preview.email) : 'no account yet'}). It was sent to you instead.`, HEALTH.done.color, HEALTH.done.tint)
        : '',
      paragraph(`Hello ${esc(first)},<br>${esc(p.intro)}`),
      ...rows,
      how,
    ],
    button: p.url ? { label: 'Open my work', url: p.url } : undefined,
    footer: 'The PMO assistant follows up every working morning on milestones that are late, blocked, close to their deadline or without an update. You can stop these emails from the notifications panel.',
  });
  const text = [
    ...(p.preview ? [`TEST MODE: this follow-up is for ${p.preview.name} (${p.preview.email ?? 'no account yet'}).`, ''] : []),
    `Hello ${first},`,
    '',
    p.intro,
    ...[...groups].flatMap(([project, items]) => [
      '',
      project,
      ...items.map((i) => `- ${i.task}: ${i.reason}${i.before ? ` (${nth(i.before + 1)} reminder)` : ''}. Due ${fmtDate(i.due)}, ${STATUS[i.status] ?? i.status}, ${i.progress}%.${i.ownerName ? ` Owner: ${i.ownerName} (no account yet).` : ''}`),
    ]),
    '',
    'Reply to this email with your update in your own words. I will write back what I will change, and update the system once you agree.',
    ...(p.url ? ['', `Open my work: ${p.url}`] : []),
  ].join('\n');
  return { subject, text, html };
}

export interface EscalationItem extends FollowupItem {
  level: number;
  /** Who was asked and did not answer, how many times, since when. */
  askedName: string;
  askedTimes: number;
  since: string;
}

/** The escalation: milestones whose owner did not answer the follow-ups, to the next person up the line. */
export function escalationEmail(p: {
  who: string;
  dateLabel: string;
  items: EscalationItem[];
  url: string;
  preview?: { name: string; email: string | null };
}): { subject: string; text: string; html: string } {
  const first = p.who.split(/\s+/)[0] || p.who;
  const n = p.items.length;
  const subject = `${p.preview ? `[TEST for ${p.preview.name}] ` : ''}SWiSH PMO: escalation, ${n} milestone${n === 1 ? '' : 's'} without an answer`;
  const intro = `${n === 1 ? 'The milestone below was' : `The ${n} milestones below were`} followed up without any update from ${n === 1 ? 'its owner' : 'their owners'}. You are the next level: please step in.`;
  const groups = new Map<string, EscalationItem[]>();
  for (const i of p.items) groups.set(`${i.projectCode} ${i.projectName}`, [...(groups.get(`${i.projectCode} ${i.projectName}`) ?? []), i]);
  const rows = [...groups].map(([project, items]) =>
    section(
      project,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;border-collapse:separate">${items
        .map((i, k) => {
          const t = TONE[i.tone];
          const top = k ? `border-top:1px solid ${LINE};` : '';
          return `<tr><td width="4" style="${top}background:${HEALTH.off_track.color};font-size:0" bgcolor="${HEALTH.off_track.color}">&nbsp;</td><td style="${top}padding:12px 14px;${FONT};color:${INK}">
<div style="font-size:15px;font-weight:600;line-height:21px">${esc(i.task)} <span style="font-size:11px;font-weight:700;color:#ffffff;background:${HEALTH.off_track.color};border-radius:9px;padding:2px 8px;white-space:nowrap">Level ${i.level}</span></div>
<div style="margin-top:4px;font-size:13px;color:${t.color};font-weight:700">${esc(i.reason)}</div>
<div style="margin-top:4px;font-size:12px;color:${MUTED}">${esc(i.askedName)} was asked ${i.askedTimes} time${i.askedTimes === 1 ? '' : 's'} since ${esc(fmtDate(i.since))} with no update &nbsp;·&nbsp; Due ${esc(fmtDate(i.due))} &nbsp;·&nbsp; ${esc(STATUS[i.status] ?? i.status)} &nbsp;·&nbsp; ${i.progress}%</div>
</td></tr>`;
        })
        .join('')}</table>`,
    ),
  );
  const how = callout(
    `<b>Reply to this email with what should happen.</b><br>For example: <i>"Move the deadline to 20 December, the vendor is late"</i>, <i>"Mark it blocked: waiting for the budget"</i> or <i>"Set it to 60%, I checked with the team"</i>. I will write back the change, and make it once you agree.`,
    ACCENT,
    '#f0fdfa',
  );
  const html = emailShell({
    subject,
    title: 'Escalation: your decision is needed',
    subtitle: p.dateLabel,
    preheader: intro,
    rows: [
      p.preview
        ? callout(`<b>Test mode.</b> This escalation is for <b>${esc(p.preview.name)}</b> (${p.preview.email ? esc(p.preview.email) : 'no account yet'}). It was sent to you instead.`, HEALTH.done.color, HEALTH.done.tint)
        : '',
      paragraph(`Hello ${esc(first)},<br>${esc(intro)}`),
      ...rows,
      how,
    ],
    button: p.url ? { label: 'Open SWiSH PMO', url: p.url } : undefined,
    footer: 'Raised by the PMO assistant after the follow-ups to the owner went unanswered. Each escalation is recorded on the milestone; it climbs one level each time the follow-ups stay unanswered.',
  });
  const text = [
    ...(p.preview ? [`TEST MODE: this escalation is for ${p.preview.name} (${p.preview.email ?? 'no account yet'}).`, ''] : []),
    `Hello ${first},`,
    '',
    intro,
    ...[...groups].flatMap(([project, items]) => [
      '',
      project,
      ...items.map((i) => `- [Level ${i.level}] ${i.task}: ${i.reason}. ${i.askedName} was asked ${i.askedTimes} time(s) since ${fmtDate(i.since)} with no update. Due ${fmtDate(i.due)}, ${STATUS[i.status] ?? i.status}, ${i.progress}%.`),
    ]),
    '',
    'Reply to this email with what should happen. I will write back the change, and make it once you agree.',
    ...(p.url ? ['', `Open SWiSH PMO: ${p.url}`] : []),
  ].join('\n');
  return { subject, text, html };
}

export interface Recommendation {
  /** The server's sentence for the change. */
  action: string;
  /** The model's reason for it, from the data. */
  why: string;
}

/** The weekly AI recommendations on one project: numbered, each with its reason; approved by one reply. */
export function recommendationEmail(p: {
  who: string;
  dateLabel: string;
  project: string;
  summary: string;
  items: Recommendation[];
  url: string;
  preview?: { name: string; email: string | null };
}): { subject: string; text: string; html: string } {
  const first = p.who.split(/\s+/)[0] || p.who;
  const n = p.items.length;
  const subject = `${p.preview ? `[TEST for ${p.preview.name}] ` : ''}SWiSH PMO: ${n} recommendation${n === 1 ? '' : 's'} for ${p.project}`;
  const cards = section(
    'Recommendations',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;border-collapse:separate">${p.items
      .map((r, k) => {
        const top = k ? `border-top:1px solid ${LINE};` : '';
        return `<tr><td width="44" valign="top" align="center" style="${top}padding:14px 0 14px 12px"><span style="${FONT};display:inline-block;width:26px;height:26px;line-height:26px;border-radius:13px;background:${ACCENT};color:#ffffff;text-align:center;font-size:13px;font-weight:700">${k + 1}</span></td>
<td valign="top" style="${top}padding:14px 14px 14px 8px;${FONT};color:${INK}"><div style="font-size:15px;font-weight:600;line-height:22px">${esc(r.action)}</div>
<div style="margin-top:6px;font-size:13px;line-height:20px;color:${MUTED}"><b style="color:${INK}">Why:</b> ${esc(r.why)}</div></td></tr>`;
      })
      .join('')}</table>`,
  );
  const how = callout(
    n > 1
      ? `<b>Reply "yes" to approve all of them, only the numbers to approve some</b> (for example <i>"1 and 3"</i>), or <b>"no"</b> to dismiss them. You can also reply with your own instruction. Nothing changes until you approve; this expires in 24 hours.`
      : `<b>Reply "yes" to approve it</b> or <b>"no"</b> to dismiss it. You can also reply with your own instruction. Nothing changes until you approve; this expires in 24 hours.`,
    HEALTH.at_risk.color,
    HEALTH.at_risk.tint,
  );
  const html = emailShell({
    subject,
    title: 'AI recommendations',
    subtitle: `${p.project} · ${p.dateLabel}`,
    preheader: p.summary,
    rows: [
      p.preview
        ? callout(`<b>Test mode.</b> These recommendations are for <b>${esc(p.preview.name)}</b> (${p.preview.email ? esc(p.preview.email) : 'no account yet'}). Approving them here changes nothing.`, HEALTH.done.color, HEALTH.done.tint)
        : '',
      paragraph(`Hello ${esc(first)},<br>${esc(p.summary)}`),
      cards,
      how,
    ],
    button: p.url ? { label: 'Open the project', url: p.url } : undefined,
    footer: 'Written by the PMO assistant from the project data, once a week for projects with late, blocked or at-risk milestones. Approved changes are made with your own permissions and recorded under your name.',
  });
  const text = [
    ...(p.preview ? [`TEST MODE: these recommendations are for ${p.preview.name} (${p.preview.email ?? 'no account yet'}). Approving them here changes nothing.`, ''] : []),
    `Hello ${first},`,
    '',
    p.summary,
    '',
    ...p.items.flatMap((r, k) => [`${k + 1}. ${r.action}`, `   Why: ${r.why}`]),
    '',
    n > 1 ? 'Reply "yes" to approve all, only the numbers to approve some (for example "1 and 3"), or "no". Nothing changes until you approve.' : 'Reply "yes" to approve it or "no" to dismiss it. Nothing changes until you approve.',
    ...(p.url ? ['', `Open the project: ${p.url}`] : []),
  ].join('\n');
  return { subject, text, html };
}
