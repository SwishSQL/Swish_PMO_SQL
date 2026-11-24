import type { Health } from '../shared/types';
import { ACCENT, FONT, HEALTH, INK, LINE, MUTED, SOFT, bar, callout, emailShell, esc, paragraph, pill, section } from './emailLayout';

// The projects briefing: key numbers, the AI summary and priorities, a health chart, each project's progress and
// milestones, and what is due next. Sent on its own, and as the weekly reminder (with the update that is due).

export interface BriefingProject {
  code: string;
  name: string;
  health: Health;
  progress: number;
  endDate: string;
  done: number;
  open: number;
  overdue: number;
  blocked: number;
}

export interface BriefingData {
  who: string;
  /** e.g. "Thursday, 29 October 2026". */
  dateLabel: string;
  url: string;
  summary: string;
  priorities: string[];
  projects: BriefingProject[];
  /** Open milestones and tasks due soon (or late), soonest first. */
  upcoming: { code: string; task: string; due: string; daysLeft: number }[];
  /** The weekly update still owed for these project codes: shown first, and the button leads to it. */
  updateDue?: string;
}

const ORDER: Health[] = ['on_track', 'at_risk', 'off_track', 'not_started', 'done'];
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function briefingEmail(d: BriefingData): { subject: string; text: string; html: string } {
  const first = d.who.split(/\s+/)[0] || d.who;
  const ps = d.projects;
  const active = ps.filter((p) => p.health !== 'done');
  const avg = active.length ? Math.round(active.reduce((n, p) => n + clamp(p.progress), 0) / active.length) : 0;
  const overdue = ps.reduce((n, p) => n + p.overdue, 0);
  const blocked = ps.reduce((n, p) => n + p.blocked, 0);
  const day = d.dateLabel.replace(/^\w+,\s*/, '');
  const subject = d.updateDue ? `SWiSH PMO: your weekly briefing, update due (${day})` : `SWiSH PMO: your projects briefing, ${day}`;

  const kpi = (value: string, label: string, color = INK) =>
    `<td width="25%" valign="top" style="padding:0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SOFT};border-radius:10px" bgcolor="${SOFT}"><tr><td align="center" style="padding:16px 6px;${FONT}">
<div style="font-size:26px;line-height:30px;font-weight:700;color:${color}">${esc(value)}</div>
<div style="font-size:12px;color:${MUTED};margin-top:4px">${esc(label)}</div></td></tr></table></td>`;
  const kpis = `<tr><td style="padding:24px 28px 0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${kpi(String(ps.length), ps.length === 1 ? 'Project' : 'Projects')}
${kpi(`${avg}%`, 'Avg. progress (active)')}
${kpi(String(overdue), 'Overdue items', overdue ? HEALTH.off_track.color : INK)}
${kpi(String(blocked), 'Blocked items', blocked ? HEALTH.at_risk.color : INK)}
</tr></table></td></tr>`;

  const ai =
    d.summary || d.priorities.length
      ? section(
          'AI summary',
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="4" style="background:${ACCENT};font-size:0" bgcolor="${ACCENT}">&nbsp;</td>
<td style="background:#f0fdfa;padding:16px 18px;${FONT};font-size:15px;line-height:23px;color:${INK}" bgcolor="#f0fdfa">
${d.summary ? `<p style="margin:0">${esc(d.summary)}</p>` : ''}
${
  d.priorities.length
    ? `<p style="margin:14px 0 6px 0;font-weight:700">Priorities this week</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">${d.priorities
        .map(
          (x, i) => `<tr><td valign="top" style="padding:4px 10px 4px 0"><span style="${FONT};display:inline-block;width:22px;height:22px;line-height:22px;border-radius:11px;background:${ACCENT};color:#ffffff;text-align:center;font-size:12px;font-weight:700">${i + 1}</span></td>
<td valign="top" style="padding:4px 0;${FONT};font-size:14px;line-height:21px;color:${INK}">${esc(x)}</td></tr>`,
        )
        .join('')}</table>`
    : ''
}
</td></tr></table>`,
        )
      : '';

  const counts = ORDER.map((h) => [h, ps.filter((p) => p.health === h).length] as const).filter(([, n]) => n);
  const health = ps.length
    ? section(
        'Portfolio health',
        `${bar(counts.map(([h, n]) => [Math.round((n / ps.length) * 100), HEALTH[h].color]), 14)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px"><tr>${counts
          .map(
            ([h, n]) =>
              `<td style="padding-right:16px;${FONT};font-size:13px;color:${INK}"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${HEALTH[h].color};margin-right:6px"></span>${HEALTH[h].label} <b>${n}</b></td>`,
          )
          .join('')}</tr></table>`,
      )
    : '';

  const rows = ps
    .map((p) => {
      const pc = clamp(p.progress);
      const total = p.done + p.open;
      const ms = total
        ? bar(
            [
              [Math.round((p.done / total) * 100), HEALTH.done.color],
              [Math.round((p.overdue / total) * 100), HEALTH.off_track.color],
              [Math.round((p.blocked / total) * 100), HEALTH.at_risk.color],
            ],
            6,
          )
        : '';
      return `<tr><td style="padding:14px 0;border-top:1px solid ${LINE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top" style="${FONT};color:${INK}"><span style="font-size:12px;font-weight:700;color:${MUTED}">${esc(p.code)}</span><br><span style="font-size:15px;font-weight:600;line-height:21px">${esc(p.name)}</span></td>
<td valign="top" align="right" width="110">${pill(p.health)}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px"><tr>
<td valign="middle">${bar([[pc, (HEALTH[p.health] ?? HEALTH.on_track).color]])}</td>
<td valign="middle" width="48" align="right" style="${FONT};font-size:13px;font-weight:700;color:${INK}">${pc}%</td></tr></table>
${ms ? `<div style="margin-top:8px">${ms}</div>` : ''}
<p style="margin:8px 0 0 0;${FONT};font-size:12px;color:${MUTED}">Ends ${esc(fmtDate(p.endDate))}${total ? ` &nbsp;·&nbsp; ${p.done}/${total} milestones done` : ''}${p.overdue ? ` &nbsp;·&nbsp; <span style="color:${HEALTH.off_track.color};font-weight:700">${p.overdue} overdue</span>` : ''}${p.blocked ? ` &nbsp;·&nbsp; <span style="color:${HEALTH.at_risk.color};font-weight:700">${p.blocked} blocked</span>` : ''}</p>
</td></tr>`;
    })
    .join('');
  const projects = ps.length
    ? section(
        'Your projects',
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
<p style="margin:6px 0 0 0;${FONT};font-size:11px;color:${MUTED}">Thin bar: milestones <span style="color:${HEALTH.done.color}">■</span> done <span style="color:${HEALTH.off_track.color}">■</span> overdue <span style="color:${HEALTH.at_risk.color}">■</span> blocked</p>`,
      )
    : '';

  const up = d.upcoming.slice(0, 8);
  const upcoming = up.length
    ? section(
        'Coming up',
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;border-collapse:separate">${up
          .map((u, i) => {
            const late = u.daysLeft < 0;
            const when = late ? `${-u.daysLeft}d late` : u.daysLeft === 0 ? 'Today' : `in ${u.daysLeft}d`;
            const top = i ? `border-top:1px solid ${LINE};` : '';
            return `<tr><td style="padding:10px 14px;${top}${FONT};font-size:13px;color:${INK}"><b style="color:${MUTED}">${esc(u.code)}</b>&nbsp; ${esc(u.task)}</td>
<td align="right" style="padding:10px 14px;${top}${FONT};font-size:13px;white-space:nowrap;color:${late ? HEALTH.off_track.color : INK}">${esc(fmtDate(u.due))} <span style="color:${late ? HEALTH.off_track.color : MUTED}">(${when})</span></td></tr>`;
          })
          .join('')}</table>`,
      )
    : '';

  const due = d.updateDue
    ? callout(`<b>Your weekly update is due</b> for ${esc(d.updateDue)}. It takes a few minutes and keeps the PMO dashboard current.`, HEALTH.at_risk.color, HEALTH.at_risk.tint)
    : '';
  const html = emailShell({
    subject,
    title: d.updateDue ? 'Your weekly briefing' : 'Your projects briefing',
    subtitle: d.dateLabel,
    preheader: d.summary,
    rows: [paragraph(`Hello ${esc(first)}, here is where your projects stand today.`), due, kpis, ai, health, projects, upcoming],
    button: d.url ? { label: d.updateDue ? 'Write the update' : 'Open SWiSH PMO', url: d.url } : undefined,
    footer: 'The summary and priorities were written by AI from the project data in SWiSH PMO; check them in the system before acting. You can stop these emails from the notifications panel.',
  });

  const text = [
    `Hello ${first},`,
    '',
    `Your projects briefing, ${d.dateLabel}`,
    ...(d.updateDue ? ['', `Your weekly update is due for: ${d.updateDue}.`] : []),
    '',
    `${ps.length} projects, ${avg}% average progress (active), ${overdue} overdue, ${blocked} blocked.`,
    ...(d.summary ? ['', d.summary] : []),
    ...(d.priorities.length ? ['', 'Priorities this week:', ...d.priorities.map((x, i) => `${i + 1}. ${x}`)] : []),
    ...(ps.length ? ['', 'Your projects:', ...ps.map((p) => `- ${p.code} ${p.name}: ${HEALTH[p.health]?.label ?? p.health}, ${clamp(p.progress)}%, ends ${fmtDate(p.endDate)}`)] : []),
    ...(up.length ? ['', 'Coming up:', ...up.map((u) => `- ${u.code} ${u.task}: ${fmtDate(u.due)}`)] : []),
    ...(d.url ? ['', `Open it: ${d.url}`] : []),
    '',
    'The summary and priorities were written by AI from the project data; check them in the system.',
  ].join('\n');

  return { subject, text, html };
}
