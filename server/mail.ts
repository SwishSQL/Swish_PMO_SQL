import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

// Sending mail, for the password a new person is emailed the first time they sign in. Settings come from the
// environment only (the .env file or the service settings), never from code or the database:
//   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, MAIL_FROM (defaults to SMTP_USER).
// Microsoft 365 on port 587 takes STARTTLS: TLS is required unless SMTP_INSECURE=1, which exists for local
// development and the tests' stand-in mail server and must never be set on a real mailbox.
// MAIL_CC is deliberately not used here: a copy of an emailed password would reach whoever is on that list.
// Every email is in English only: the working language of the company's mail (the app itself is bilingual).

/** A setting as typed: spaces, line breaks and one pair of quotes around it are dropped (pasting into a form adds them). */
function setting(name: string): string {
  return (process.env[name] ?? '').trim().replace(/^(["'])(.*)\1$/s, '$2').trim();
}

export function mailEnabled(): boolean {
  return Boolean(setting('SMTP_HOST') && setting('SMTP_USER') && setting('SMTP_PASS'));
}

/** What is configured, without the secret: lets an admin tell a typo from a refusal. */
export function mailDiagnostics(): string {
  const raw = process.env.SMTP_PASS ?? '';
  const notes = [
    raw !== raw.trim() ? 'it had a space or line break around it, removed' : '',
    /^(["']).*\1$/s.test(raw.trim()) ? 'it was wrapped in quotes, removed' : '',
  ].filter(Boolean);
  return `Sent as ${setting('SMTP_USER')} through ${setting('SMTP_HOST')}:${setting('SMTP_PORT') || 587}; the password is ${setting('SMTP_PASS').length} characters${notes.length ? ` (${notes.join('; ')})` : ''}.`;
}

/** The public address of the app, for the sign-in link in an email. Empty when it is not known. */
export function appBase(): string {
  return (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, '');
}

let transport: Transporter | null = null;
function getTransport(): Transporter {
  const insecure = process.env.SMTP_INSECURE === '1';
  transport ??= nodemailer.createTransport({
    host: setting('SMTP_HOST'),
    port: Number(setting('SMTP_PORT') || 587),
    secure: Number(setting('SMTP_PORT') || 587) === 465,
    requireTLS: !insecure,
    ignoreTLS: insecure,
    auth: { user: setting('SMTP_USER'), pass: setting('SMTP_PASS') },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transport;
}

export async function sendMail(to: string, subject: string, text: string, html: string): Promise<void> {
  await getTransport().sendMail({
    from: setting('MAIL_FROM') || setting('SMTP_USER'),
    to,
    subject,
    text,
    html,
  });
}

/** The email for a project or a task given to someone. */
export function assignmentEmail(
  kind: 'task.assigned' | 'project.owner' | 'project.assigned',
  p: { who: string; by: string; project: string; code: string; name: string; url: string },
): { subject: string; text: string; html: string } {
  const first = p.who.split(/\s+/)[0] || p.who;
  const proj = `${p.code ? p.code + ' ' : ''}${p.project}`.trim();
  const news =
    kind === 'task.assigned'
      ? `${p.by} made you the owner of "${p.name}" in the project ${proj}.`
      : kind === 'project.owner'
        ? `${p.by} made you the owner of the project ${proj}.`
        : `${p.by} started the project ${proj} in your department.`;
  const subject =
    kind === 'task.assigned' ? 'SWiSH PMO: a task was given to you' : kind === 'project.owner' ? 'SWiSH PMO: you own a project' : 'SWiSH PMO: a project in your department';
  return layout(first, news, p.url, subject);
}

/** The shared look of an event email: greeting, the news, a button, and how to stop them. */
function layout(first: string, news: string, url: string, subject: string, label = 'Open in SWiSH PMO'): { subject: string; text: string; html: string } {
  const text = [`Hello ${first},`, '', news, url ? `Open it: ${url}` : '', '', 'You can stop these emails from the notifications panel in the system.']
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  const button = url ? `<p><a href="${esc(url)}" style="display:inline-block;background:#14181d;color:#fff;text-decoration:none;border-radius:8px;padding:10px 16px;font-weight:600">${esc(label)}</a></p>` : '';
  const html = `<div style="font:15px/1.6 Segoe UI,Arial,sans-serif;color:#14181d;max-width:520px">
<p>Hello ${esc(first)},</p>
<p>${esc(news)}</p>
${button}
<p style="color:#5b6573;font-size:12px">You can stop these emails from the notifications panel in the system.</p>
</div>`;
  return { subject, text, html };
}

/** Emails that ask for a decision or remind: a deadline move to approve, a change request, a project to close, the weekly update owed. */
export function eventEmail(
  kind: 'deadline.pending' | 'closure.requested' | 'reminder.weekly' | 'change.pending',
  p: { who: string; by: string; project: string; code: string; name: string; from: string; to: string; reason: string; note: string; codes: string; delivery: string; url: string },
): { subject: string; text: string; html: string } {
  const first = p.who.split(/\s+/)[0] || p.who;
  const proj = `${p.code ? p.code + ' ' : ''}${p.project}`.trim();
  if (kind === 'deadline.pending') {
    return layout(
      first,
      `${p.by} asks to move the deadline of "${p.name}" (${proj}) from ${p.from} to ${p.to}. Reason: ${p.reason}. It waits for your decision.`,
      p.url,
      'SWiSH PMO: a deadline change needs your decision',
      'Decide in SWiSH PMO',
    );
  }
  if (kind === 'change.pending') {
    return layout(
      first,
      `${p.by} asks for a change to the project ${proj} (${p.codes}): ${p.name}. Reason: ${p.reason}. It waits for your approval.`,
      p.url,
      'SWiSH PMO: a change request waits for your approval',
      'Review the change',
    );
  }
  if (kind === 'closure.requested') {
    return layout(
      first,
      `${p.by} asks to close the project ${proj}.${p.note ? ` Note: ${p.note}.` : ''}${p.delivery ? ` Delivery document: ${p.delivery}` : ''} It waits for your approval.`,
      p.url,
      'SWiSH PMO: a project waits for closure approval',
      'Review in SWiSH PMO',
    );
  }
  return layout(first, `Your weekly update is still due for: ${p.codes}.`, p.url, 'SWiSH PMO: your weekly update is due', 'Write the update');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** The email that carries a temporary password. */
export function passwordEmail(name: string, password: string, hours: number): { subject: string; text: string; html: string } {
  const url = appBase();
  const first = name.split(/\s+/)[0] || name;
  const subject = 'Your SWiSH PMO password';
  const text = [
    `Hello ${first},`,
    '',
    'Your temporary password for SWiSH PMO:',
    '',
    `    ${password}`,
    '',
    `Sign in with your company email and this password${url ? ` at ${url}` : ''}. You will then be asked to choose your own password. This one works for ${hours} hours and is replaced as soon as you choose yours.`,
    'If you did not ask for it, you can ignore this email: nobody can sign in without it.',
  ].join('\n');
  const mono = 'font:600 20px/1.4 Consolas,Menlo,monospace;letter-spacing:1px;background:#f2f4f7;border-radius:8px;padding:12px 16px;display:inline-block;direction:ltr';
  const html = `<div style="font:15px/1.6 Segoe UI,Arial,sans-serif;color:#14181d;max-width:520px">
<p>Hello ${esc(first)},</p>
<p>Your temporary password for <b>SWiSH PMO</b>:</p>
<p><span style="${mono}">${esc(password)}</span></p>
<p>Sign in with your company email and this password${url ? ` at <a href="${esc(url)}">${esc(url)}</a>` : ''}. You will then be asked to choose your own password. This one works for ${hours} hours and is replaced as soon as you choose yours.</p>
<p style="color:#5b6573">If you did not ask for it, you can ignore this email: nobody can sign in without it.</p>
</div>`;
  return { subject, text, html };
}
