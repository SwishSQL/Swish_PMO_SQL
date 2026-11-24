import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { briefingEmail } from './briefingEmail';
import type { BriefingData } from './briefingEmail';
import { FONT, HEALTH, INK, LINE, MUTED, callout, details, emailShell, esc, paragraph, section } from './emailLayout';
import { replyAddress } from './inbound';

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

/** Replies go to the inbound address with this recipient's tag, when replies are set up (see inbound.ts). */
export async function sendMail(to: string, subject: string, text: string, html: string, thread?: { inReplyTo?: string; ref?: string }): Promise<void> {
  await getTransport().sendMail({
    from: setting('MAIL_FROM') || setting('SMTP_USER'),
    to,
    replyTo: replyAddress(to, thread?.ref),
    subject,
    text,
    html,
    ...(thread?.inReplyTo ? { inReplyTo: thread.inReplyTo, references: thread.inReplyTo } : {}),
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
  const title = kind === 'task.assigned' ? 'A task is yours' : kind === 'project.owner' ? 'You own a project' : 'A new project in your department';
  const rows: [string, string][] = kind === 'task.assigned' ? [['Task', p.name], ['Project', proj], ['Given by', p.by]] : [['Project', proj], [kind === 'project.owner' ? 'Given by' : 'Started by', p.by]];
  return layout(first, news, p.url, subject, { title, rows });
}

/**
 * The shared look of an event email: the dark header with its title, the greeting, the news in a callout, the
 * details in a card, a button, and how to stop them. The plain-text part says the same in sentences.
 */
function layout(
  first: string,
  news: string,
  url: string,
  subject: string,
  o: { title: string; rows?: [string, string][]; label?: string; tone?: 'info' | 'decision' },
): { subject: string; text: string; html: string } {
  const label = o.label ?? 'Open in SWiSH PMO';
  const text = [`Hello ${first},`, '', news, url ? `${label}: ${url}` : '', '', 'You can stop these emails from the notifications panel in the system.']
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  const html = emailShell({
    subject,
    title: o.title,
    preheader: news,
    rows: [
      paragraph(`Hello ${esc(first)},`),
      o.tone === 'decision' ? callout(esc(news), HEALTH.at_risk.color, HEALTH.at_risk.tint) : callout(esc(news)),
      details(o.rows ?? []),
    ],
    button: url ? { label, url } : undefined,
    footer: 'You can stop these emails from the notifications panel in the system.',
  });
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
      {
        title: 'A deadline change needs your decision',
        tone: 'decision',
        rows: [['Milestone', p.name], ['Project', proj], ['Deadline', `${p.from}  →  ${p.to}`], ['Reason', p.reason], ['Asked by', p.by]],
        label: 'Decide in SWiSH PMO',
      },
    );
  }
  if (kind === 'change.pending') {
    return layout(
      first,
      `${p.by} asks for a change to the project ${proj} (${p.codes}): ${p.name}. Reason: ${p.reason}. It waits for your approval.`,
      p.url,
      'SWiSH PMO: a change request waits for your approval',
      {
        title: 'A change request waits for your approval',
        tone: 'decision',
        rows: [['Change', p.name], ['Project', proj], ['Request', p.codes], ['Reason', p.reason], ['Asked by', p.by]],
        label: 'Review the change',
      },
    );
  }
  if (kind === 'closure.requested') {
    return layout(
      first,
      `${p.by} asks to close the project ${proj}.${p.note ? ` Note: ${p.note}.` : ''}${p.delivery ? ` Delivery document: ${p.delivery}` : ''} It waits for your approval.`,
      p.url,
      'SWiSH PMO: a project waits for closure approval',
      {
        title: 'A project waits for closure approval',
        tone: 'decision',
        rows: [['Project', proj], ['Note', p.note], ['Delivery document', p.delivery], ['Asked by', p.by]],
        label: 'Review in SWiSH PMO',
      },
    );
  }
  return layout(first, `Your weekly update is still due for: ${p.codes}.`, p.url, 'SWiSH PMO: your weekly update is due', {
    title: 'Your weekly update is due',
    tone: 'decision',
    rows: [['Projects', p.codes]],
    label: 'Write the update',
  });
}

/** The weekly reminder: the full projects briefing when there is one (AI summary, charts), else the plain reminder. */
export function weeklyEmail(
  p: { who: string; codes: string; url: string },
  brief: Omit<BriefingData, 'who' | 'url' | 'updateDue'> | null,
): { subject: string; text: string; html: string } {
  if (!brief || (!brief.summary && !brief.priorities.length)) {
    return eventEmail('reminder.weekly', { who: p.who, by: '', project: '', code: '', name: '', from: '', to: '', reason: '', note: '', codes: p.codes, delivery: '', url: p.url });
  }
  return briefingEmail({ ...brief, who: p.who, url: p.url, updateDue: p.codes });
}

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
  const mono = "font-family:Consolas,Menlo,'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:2px;color:#14181d;direction:ltr";
  const html = emailShell({
    subject,
    title: 'Your temporary password',
    preheader: 'Your temporary password for SWiSH PMO',
    rows: [
      paragraph(`Hello ${esc(first)},<br>here is your temporary password for <b>SWiSH PMO</b>:`),
      `<tr><td align="center" style="padding:20px 32px 0 32px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:#f2f4f7;border:1px dashed #c3cad3;border-radius:10px" bgcolor="#f2f4f7"><tr><td style="padding:14px 26px;${mono}">${esc(password)}</td></tr></table></td></tr>`,
      paragraph(
        `Sign in with your company email and this password. You will then be asked to choose your own password. This one works for <b>${hours} hours</b> and is replaced as soon as you choose yours.`,
      ),
    ],
    button: url ? { label: 'Sign in to SWiSH PMO', url } : undefined,
    footer: 'If you did not ask for it, you can ignore this email: nobody can sign in without it.',
  });
  return { subject, text, html };
}

/** A new account (or a reset password): the one-time link to choose a password, sent to the person only. */
export function setupEmail(p: { name: string; email: string; url: string; expires: Date; reset: boolean; by: string }): { subject: string; text: string; html: string } {
  const first = p.name.split(/\s+/)[0] || p.name;
  const until = p.expires.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuwait' });
  const subject = p.reset ? 'Set a new password for SWiSH PMO' : 'Your SWiSH PMO account is ready';
  const lead = p.reset
    ? `${p.by} reset your SWiSH PMO password. Choose a new one with the button below.`
    : `${p.by} created your SWiSH PMO account. Choose your password with the button below to sign in.`;
  const text = [
    `Hello ${first},`,
    '',
    lead,
    '',
    `Your sign-in email: ${p.email}`,
    `Choose your password: ${p.url}`,
    '',
    `The link works once, until ${until} (Kuwait time). If it has expired, ask the PMO to send a new one.`,
  ].join('\n');
  const html = emailShell({
    subject,
    title: p.reset ? 'Set a new password' : 'Your account is ready',
    preheader: lead,
    rows: [
      paragraph(`Hello ${esc(first)},<br>${esc(lead)}`),
      paragraph(`Your sign-in email: <b dir="ltr">${esc(p.email)}</b>`),
    ],
    button: { label: p.reset ? 'Choose a new password' : 'Choose your password', url: p.url },
    footer: `The link works once, until ${esc(until)} (Kuwait time). If it has expired, ask the PMO to send a new one. If you did not expect this email, you can ignore it.`,
  });
  return { subject, text, html };
}

/** The admin's test email: proves the mailbox works, in the same look as the real ones. */
export function testEmail(): { subject: string; text: string; html: string } {
  const subject = 'SWiSH PMO: test email';
  const news = 'This is a test from SWiSH PMO. If you can read it, the system can email people their first password.';
  return {
    subject,
    text: news,
    html: emailShell({ subject, title: 'Test email', preheader: news, rows: [callout(esc(news))], footer: 'Sent from Users & permissions in SWiSH PMO.' }),
  };
}

/** The answer to a question someone emailed in reply to the system: read only, from what they may see. */
export function answerEmail(p: {
  who: string;
  subject: string;
  question: string;
  answer: string;
  projects: { code: string; name: string; url: string }[];
  /** A change waiting for YES, done, or refused by the system: the header and the colour say which. */
  kind?: 'answer' | 'confirm' | 'done' | 'refused';
}): {
  subject: string;
  text: string;
  html: string;
} {
  const first = p.who.split(/\s+/)[0] || p.who;
  const subject = /^re:/i.test(p.subject.trim()) ? p.subject.trim() : `Re: ${p.subject.trim() || 'SWiSH PMO'}`;
  const kind = p.kind ?? 'answer';
  const footer =
    kind === 'answer'
      ? 'Answered by AI from the project data you can see in SWiSH PMO; check it in the system before acting. Reply to ask another question, or to ask for a change.'
      : 'Changes asked for by email are made only after you reply YES, with your own permissions in SWiSH PMO, and are recorded under your name.';
  const tone: Record<string, [string, string] | undefined> = { confirm: [HEALTH.at_risk.color, HEALTH.at_risk.tint], done: [HEALTH.on_track.color, HEALTH.on_track.tint], refused: [HEALTH.off_track.color, HEALTH.off_track.tint] };
  // Arabic answers are laid out right to left; Outlook ignores dir="auto", so it is decided here.
  const block = (s: string, size: number, color: string) => {
    const rtl = /[؀-ۿ]/.test(s);
    return `<p dir="${rtl ? 'rtl' : 'ltr'}" style="margin:0;${FONT};font-size:${size}px;line-height:${Math.round(size * 1.55)}px;color:${color};text-align:${rtl ? 'right' : 'left'}">${esc(s).replace(/\n/g, '<br>')}</p>`;
  };
  const links = p.projects.length
    ? section(
        'Projects in this answer',
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;border-collapse:separate">${p.projects
          .map(
            (x, i) =>
              `<tr><td style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ''}${FONT};font-size:14px;color:${INK}"><b style="color:${MUTED}">${esc(x.code)}</b>&nbsp; ${x.url ? `<a href="${esc(x.url)}" style="color:#0f766e;text-decoration:none">${esc(x.name)}</a>` : esc(x.name)}</td></tr>`,
          )
          .join('')}</table>`,
      )
    : '';
  const html = emailShell({
    subject,
    title: { answer: 'Your answer', confirm: 'Please confirm', done: 'Done', refused: 'Not done' }[kind],
    preheader: p.answer,
    rows: [paragraph(`Hello ${esc(first)},`), callout(block(p.answer, 15, INK), ...(tone[kind] ?? [])), section('You asked', block(p.question, 13, MUTED)), links],
    footer,
  });
  const text = [
    `Hello ${first},`,
    '',
    p.answer,
    ...(p.projects.length ? ['', ...p.projects.map((x) => `- ${x.code} ${x.name}${x.url ? `: ${x.url}` : ''}`)] : []),
    '',
    `You asked: ${p.question}`,
    '',
    footer,
  ].join('\n');
  return { subject, text, html };
}
