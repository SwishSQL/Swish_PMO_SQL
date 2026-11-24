import type { Health } from '../shared/types';

// The shared look of every email the system sends. Email clients (Outlook above all) ignore most CSS, so the layout
// is nested tables with inline styles and bgcolor attributes, at most 600px wide; charts are table cells with widths
// and colours. No images, no SVG, no scripts, no web fonts: what renders in Outlook renders everywhere.

export const INK = '#14181d';
export const MUTED = '#5b6573';
export const LINE = '#e3e7ec';
export const SOFT = '#f4f6f8';
export const ACCENT = '#0f766e';
export const FONT = "font-family:'Segoe UI',Arial,Helvetica,sans-serif";

export const HEALTH: Record<Health, { label: string; color: string; tint: string }> = {
  on_track: { label: 'On track', color: '#15803d', tint: '#dcfce7' },
  at_risk: { label: 'At risk', color: '#b45309', tint: '#fef3c7' },
  off_track: { label: 'Off track', color: '#b91c1c', tint: '#fee2e2' },
  done: { label: 'Completed', color: '#1d4ed8', tint: '#dbeafe' },
  not_started: { label: 'Not started', color: '#64748b', tint: '#f1f5f9' },
};

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function pill(h: Health): string {
  const s = HEALTH[h] ?? HEALTH.not_started;
  return `<span style="${FONT};display:inline-block;background:${s.tint};color:${s.color};border-radius:10px;padding:2px 9px;font-size:11px;font-weight:700;white-space:nowrap">${s.label}</span>`;
}

/** A horizontal bar: segments of [share %, colour] on a light track. */
export function bar(segments: [number, string][], height = 10): string {
  const parts = segments.filter(([w]) => w > 0);
  const used = parts.reduce((n, [w]) => n + w, 0);
  const cells = parts.map(([w, c]) => `<td width="${w}%" style="background:${c};height:${height}px;font-size:0;line-height:0" bgcolor="${c}">&nbsp;</td>`);
  if (used < 100) cells.push(`<td width="${100 - used}%" style="background:${LINE};height:${height}px;font-size:0;line-height:0" bgcolor="${LINE}">&nbsp;</td>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-radius:${height / 2}px;overflow:hidden"><tr>${cells.join('')}</tr></table>`;
}

/** A body row with a small upper-case heading. */
export function section(title: string, body: string): string {
  return `<tr><td style="padding:24px 32px 0 32px">
<p style="margin:0 0 12px 0;${FONT};font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${MUTED}">${esc(title)}</p>
${body}
</td></tr>`;
}

/** A body row of plain text (already escaped HTML). */
export function paragraph(html: string): string {
  return `<tr><td style="padding:20px 32px 0 32px;${FONT};font-size:15px;line-height:23px;color:${INK}">${html}</td></tr>`;
}

/** A tinted box with a coloured edge, for the news or a notice (already escaped HTML). */
export function callout(html: string, color = ACCENT, tint = '#f0fdfa'): string {
  return `<tr><td style="padding:20px 32px 0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="4" style="background:${color};font-size:0" bgcolor="${color}">&nbsp;</td>
<td style="background:${tint};padding:14px 18px;${FONT};font-size:15px;line-height:23px;color:${INK}" bgcolor="${tint}">${html}</td></tr></table></td></tr>`;
}

/** Label and value rows in a bordered card; empty values are left out. */
export function details(rows: [string, string][]): string {
  const shown = rows.filter(([, v]) => v.trim());
  if (!shown.length) return '';
  return `<tr><td style="padding:20px 32px 0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;border-collapse:separate">${shown
    .map(
      ([k, v], i) => `<tr><td valign="top" width="120" style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ''}${FONT};font-size:13px;color:${MUTED}">${esc(k)}</td>
<td valign="top" style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ''}${FONT};font-size:14px;line-height:21px;color:${INK}">${esc(v)}</td></tr>`,
    )
    .join('')}</table></td></tr>`;
}

export interface Shell {
  subject: string;
  /** The big line in the dark header. */
  title: string;
  /** The small line under it, e.g. the date. */
  subtitle?: string;
  /** Hidden preview text shown by mail clients next to the subject. */
  preheader?: string;
  /** Body rows built with the helpers above. */
  rows: string[];
  button?: { label: string; url: string };
  footer: string;
}

export function emailShell(s: Shell): string {
  const button = s.button?.url
    ? `<tr><td align="center" style="padding:28px 32px 4px 32px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${INK};border-radius:8px" bgcolor="${INK}"><a href="${esc(s.button.url)}" style="display:inline-block;padding:12px 26px;${FONT};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none">${esc(s.button.label)}</a></td></tr></table></td></tr>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>${esc(s.subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f4" bgcolor="#eef1f4">
${s.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${esc(s.preheader.slice(0, 140))}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f4" bgcolor="#eef1f4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden" bgcolor="#ffffff">
<tr><td style="background:${INK};padding:26px 32px" bgcolor="${INK}">
<p style="margin:0;${FONT};font-size:12px;font-weight:700;letter-spacing:2px;color:#5eead4">SWiSH PMO</p>
<p style="margin:6px 0 0 0;${FONT};font-size:24px;line-height:30px;font-weight:700;color:#ffffff">${esc(s.title)}</p>
${s.subtitle ? `<p style="margin:4px 0 0 0;${FONT};font-size:13px;color:#aab4c0">${esc(s.subtitle)}</p>` : ''}
</td></tr>
${s.rows.join('\n')}
${button}
<tr><td style="padding:24px 32px 28px 32px;${FONT};font-size:11px;line-height:17px;color:${MUTED}">${esc(s.footer)}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
