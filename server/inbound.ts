import { createHmac, timingSafeEqual } from 'node:crypto';

// Replies by email. Every email the system sends carries a Reply-To on the inbound address of the mail service
// (Postmark), with a tag after "+" that only this server can make for that recipient. A reply comes back to the
// server as a webhook; it is acted on only when the tag matches the sender's address, so a stranger who knows the
// inbound address, or someone writing in another person's name without the tag from their mailbox, gets nowhere.
//   INBOUND_ADDRESS  the inbound address, e.g. 297ce...@inbound.postmarkapp.com (not secret)
//   INBOUND_SECRET   at least 16 characters: signs the tags, and is the password of the webhook URL

const setting = (name: string) => (process.env[name] ?? '').trim();

export function inboundEnabled(): boolean {
  return /^[^@\s+]+@[^@\s]+$/.test(setting('INBOUND_ADDRESS')) && setting('INBOUND_SECRET').length >= 16;
}

/**
 * The tag that proves a reply came from the mailbox the system wrote to, about what the email was about:
 * ref is '' (nothing in particular), p<id> (a project) or a<id> (a change waiting for the person's YES).
 */
export function replyTag(email: string, ref = '', secret = setting('INBOUND_SECRET')): string {
  return createHmac('sha256', secret).update(`reply:${email.trim().toLowerCase()}${ref ? `|${ref}` : ''}`).digest('hex').slice(0, 24);
}

/** Where a reply to an email for this address should go, or undefined when replies are not set up. */
export function replyAddress(email: string, ref = ''): string | undefined {
  if (!inboundEnabled()) return undefined;
  const [local, domain] = setting('INBOUND_ADDRESS').split('@');
  return `${local}+${ref ? `${ref}-` : ''}${replyTag(email, ref)}@${domain}`;
}

/** What a reply is about, when its tag is genuine for this sender ('' for nothing in particular); null when it is not. */
export function replyRef(email: string, hash: string): string | null {
  const m = /^(?:([ap]\d{1,9})-)?([0-9a-f]{24})$/.exec(hash.trim().toLowerCase());
  if (!m) return null;
  const ref = m[1] ?? '';
  return sameText(m[2], replyTag(email, ref)) ? ref : null;
}

export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The webhook's basic-auth password matches INBOUND_SECRET. */
export function webhookAllowed(authorization: string | undefined): boolean {
  const m = /^Basic\s+(.+)$/i.exec(authorization ?? '');
  if (!m || !inboundEnabled()) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  return sameText(pass, setting('INBOUND_SECRET'));
}
