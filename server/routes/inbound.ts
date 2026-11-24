import { Router } from 'express';
import { db } from '../db';
import { aiEnabled } from '../ai';
import { actionProject, actionSize, buildFocus, cancelAction, confirmAction, pickNumbers, planReply, proposeAction, replyIntent, toProposal } from '../emailActions';
import type { Person } from '../emailActions';
import { inboundEnabled, replyRef, webhookAllowed } from '../inbound';
import { answerEmail, appBase, mailEnabled, sendMail } from '../mail';
import { normalizePermissions } from '../../shared/permissions';
import { todayIso } from '../../shared/dates';
import { portfolioSnapshot } from './ask';

export const inboundRouter = Router();

/** Emails answered per person in 24 hours. */
const DAILY_LIMIT = 30;

/**
 * A reply to a system email, as the mail service (Postmark) posts it. No session: the webhook URL carries
 * INBOUND_SECRET as its basic-auth password. The service is told 200 at once (it retries otherwise) and the
 * reply is worked on afterwards: a question is answered; a change is proposed back and made only on a YES.
 */
inboundRouter.post('/inbound/postmark', (req, res) => {
  if (!inboundEnabled()) {
    res.status(404).json({ error: 'Unknown endpoint.' });
    return;
  }
  if (!webhookAllowed(req.headers.authorization)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="inbound"');
    res.status(401).json({ error: 'Not allowed.' });
    return;
  }
  res.json({ ok: true });
  void answerReply(req.body ?? {}).catch((e) => console.error(`[inbound] a reply failed: ${(e as Error).message}`));
});

export async function answerReply(m: any): Promise<void> {
  const from = String(m.FromFull?.Email ?? '').trim().toLowerCase();
  // Only a reply to an email the system sent to this very address: anything else is dropped without an answer.
  const ref = from ? replyRef(from, String(m.MailboxHash ?? '')) : null;
  if (ref === null) {
    console.warn('[inbound] dropped a message that is not a reply to a system email');
    return;
  }
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, r.permissions AS role_permissions__json FROM users u JOIN roles r ON r.id = u.role_id
      WHERE LOWER(u.email) = $1 AND u.active = 1 AND u.temp_password = 0`,
    [from],
  );
  const user = rows[0];
  if (!user) return;
  // The service may post the same message twice; it is answered once.
  const { rows: fresh } = await db.query('INSERT INTO email_sent (user_id, [key]) OUTPUT INSERTED.user_id SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM email_sent WHERE user_id = $1 AND [key] = $2)', [
    user.id,
    `inbound:${String(m.MessageID ?? '').slice(0, 100) || Date.now()}`,
  ]);
  if (!fresh.length) return;
  const { rows: count } = await db.query(`SELECT COUNT(*) AS n FROM email_sent WHERE user_id = $1 AND [key] LIKE 'inbound:%' AND sent_at > DATEADD(DAY, -1, SYSDATETIMEOFFSET())`, [user.id]);
  if (count[0].n > DAILY_LIMIT) {
    console.warn(`[inbound] user ${user.id} is over the daily limit of emails`);
    return;
  }
  // Outlook leaves "[cid:image001.png@...]" where a picture (a signature logo) was: not part of the question.
  const question = String(m.StrippedTextReply || m.TextBody || '')
    .replace(/\[cid:[^\]]*\]/gi, '')
    .trim()
    .slice(0, 1500);
  if (!question || !mailEnabled()) return;
  const person: Person = { id: user.id, name: user.name, email: user.email };
  const subject = String(m.Subject ?? '');
  const messageId = (Array.isArray(m.Headers) ? m.Headers : []).find((h: any) => String(h?.Name).toLowerCase() === 'message-id')?.Value;
  const inReplyTo = messageId ? String(messageId) : undefined;

  const actionId = ref.startsWith('a') ? Number(ref.slice(1)) : null;
  if (actionId) {
    // Several changes: the numbers approve only those.
    const size = await actionSize(user.id, actionId);
    const pick = size > 1 ? pickNumbers(question, size) : null;
    if (pick) return confirmAction(person, actionId, subject, inReplyTo, pick);
    const intent = await replyIntent(question);
    if (intent === 'agree') return confirmAction(person, actionId, subject, inReplyTo);
    if (intent === 'refuse') return cancelAction(person, actionId, subject, inReplyTo);
  }
  if (!aiEnabled()) return;

  const projectId = ref.startsWith('p') ? Number(ref.slice(1)) : actionId ? await actionProject(user.id, actionId) : null;
  const perms = new Set(normalizePermissions(user.role_permissions));
  const snapshot = await portfolioSnapshot(perms.has('projects.view_all') || perms.has('projects.edit_all') ? null : user.id);
  const today = todayIso();
  // What came before in the thread (the quoted earlier emails), so "this project" can be understood.
  const body = String(m.TextBody ?? '');
  const quoted = body.includes(question) ? body.slice(body.indexOf(question) + question.length) : body;
  const thread = `Subject: ${subject}\n${quoted.replace(/^>+ ?/gm, '').replace(/\n{3,}/g, '\n\n').trim()}`.slice(0, 3000);
  const focus = await buildFocus(user.id, snapshot, question, projectId, thread);
  const plan = await planReply(question, today, snapshot, focus, thread);
  const proposal = toProposal(plan.actions, focus, today);
  if (proposal) return proposeAction(person, subject, question, plan.answer, proposal, inReplyTo);

  const byId = new Map(snapshot.projects.map((p) => [p.id, p]));
  const base = appBase();
  // Never an empty answer: if the assistant still had nothing to say, say where to look instead.
  const answer =
    plan.answer ||
    "I couldn't answer this by email. Open the project in SWiSH PMO to check it there, or reply with a little more detail (the project and what you need).";
  const mail = answerEmail({
    who: user.name,
    subject,
    question,
    answer,
    projects: plan.projectIds.map((id) => ({ code: byId.get(id)!.code, name: byId.get(id)!.name, url: base ? `${base}/#/projects/${id}` : '' })),
  });
  const only = plan.projectIds.length === 1 ? plan.projectIds[0] : projectId;
  await sendMail(user.email, mail.subject, mail.text, mail.html, { inReplyTo, ref: only ? `p${only}` : '' });
}
