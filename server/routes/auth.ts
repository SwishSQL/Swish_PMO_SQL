import crypto from 'node:crypto';
import { Router } from 'express';
import { db } from '../db';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  hashPassword,
  hashToken,
  requireAuth,
  route,
  verifyPassword,
  HttpError,
} from '../auth';
import { mapUser } from '../mappers';
import { str } from '../validate';
import { isCompanyEmail, COMPANY_DOMAIN, MIN_PASSWORD } from '../../shared/permissions';
import { logActivity } from '../service';
import { mailEnabled, passwordEmail, sendMail } from '../mail';

export const authRouter = Router();

// Failed sign-ins, in memory: enough to stop password guessing against a
// single instance without another moving part. Two limits: per address and
// email (one account), and per address alone (one machine trying many accounts).
type Strikes = { count: number; until: number };
const failures = new Map<string, Strikes>();
const MAX_FAILURES = 8;
const MAX_IP_FAILURES = 30;
const WINDOW_MS = 15 * 60_000;
const BAD_LOGIN = 'Email or password is not correct.';
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(crypto.randomBytes(16).toString('hex')));

const live = (s: Strikes | undefined) => (s && s.until > Date.now() ? s : undefined);
function strike(key: string): void {
  const cur = live(failures.get(key)) ?? { count: 0, until: Date.now() + WINDOW_MS };
  failures.set(key, { count: cur.count + 1, until: cur.until });
  if (failures.size > 5000) for (const [k, v] of failures) if (!live(v)) failures.delete(k);
}

/**
 * Sign in with email and password. An account an admin has just added (or
 * reset) has no password yet: it is set up only through the one-time link the
 * admin sends, never from this form, so knowing an email is not enough to
 * claim the account. No password is ever handed around or kept in code.
 */
authRouter.post(
  '/login',
  route(async (req, res) => {
    const email = str(req.body?.email, 'Email', 200).toLowerCase();
    const password = str(req.body?.password, 'Password', 200);
    if (!isCompanyEmail(email)) throw new HttpError(400, `Use your ${COMPANY_DOMAIN} company email.`);

    const key = `${req.ip}|${email}`;
    const ipKey = `${req.ip}|*`;
    if ((live(failures.get(key))?.count ?? 0) >= MAX_FAILURES || (live(failures.get(ipKey))?.count ?? 0) >= MAX_IP_FAILURES) {
      throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
    }
    const fail = (status: number, message: string) => {
      strike(key);
      strike(ipKey);
      return new HttpError(status, message);
    };

    const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = $1', [email]);
    const row = rows[0];
    // An unknown email and a wrong password get the same answer, so the form
    // does not tell a stranger which colleagues have accounts.
    if (!row) {
      // Spend the same bcrypt time as a real check, so response time does not tell either.
      await verifyPassword(password, await dummyHash());
      throw fail(401, BAD_LOGIN);
    }
    // No password exists to check yet: saying so is what lets a new person find their way in.
    if (row.must_set_password || !row.password_hash) {
      throw fail(
        403,
        mailEnabled()
          ? 'This account has no password yet. Choose "First time here? Email me my password" below, or open the setup link the PMO sent you.'
          : 'This account is not set up yet. Open the setup link the PMO sent you, or ask them for a new one.',
      );
    }
    if (!(await verifyPassword(password, row.password_hash))) throw fail(401, BAD_LOGIN);
    // The emailed password is short-lived. Only someone who knows it learns that it has expired.
    if (row.temp_password && row.temp_password_expires_at && new Date(row.temp_password_expires_at) < new Date()) {
      throw fail(401, 'That emailed password has expired. Choose "First time here? Email me my password" to get a new one.');
    }
    // Only someone who knows the password learns the account is switched off.
    if (!row.active) throw fail(403, 'This account is switched off. Ask the PMO team to turn it back on.');

    failures.delete(key);
    await db.query('UPDATE users SET last_login_at = SYSDATETIMEOFFSET() WHERE id = $1', [row.id]);
    const { token, expires } = await createSession(row.id);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, expires });
    res.json({ user: mapUser(row), mustChangePassword: Boolean(row.temp_password) });
  }),
);

// ---- First sign-in by email ------------------------------------------------------------
// The person types their company email on the sign-in page and asks for their password: a temporary one is
// emailed to that address, which only the owner of the mailbox can read. They sign in with it and are then
// made to choose their own. The answer is the same whether or not the email has an account waiting, so the
// form does not tell a stranger who has one. Only accounts that never chose a password (or are still on an
// emailed one) are eligible: a working password is never replaced by someone else's request.

const TEMP_HOURS = 24;
const COOLDOWN_MINUTES = 10;
const ASKS_PER_HOUR_PER_IP = 20;
const asks = new Map<string, number[]>();
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/l/I

/** Twelve characters in three groups (about 69 bits), easy to read and to type. */
function tempPassword(): string {
  const pick = () => ALPHABET[crypto.randomInt(ALPHABET.length)];
  return [0, 1, 2].map(() => Array.from({ length: 4 }, pick).join('')).join('-');
}

/** Whether emailing the first password is available, so the sign-in page can offer it. */
authRouter.get('/config', (_req, res) => {
  res.json({ emailSignIn: mailEnabled() });
});

authRouter.post(
  '/first-access',
  route(async (req, res) => {
    const email = str(req.body?.email, 'Email', 200).toLowerCase();
    if (!isCompanyEmail(email)) throw new HttpError(400, `Use your ${COMPANY_DOMAIN} company email.`);
    if (!mailEnabled()) throw new HttpError(503, 'Email is not set up yet. Ask the PMO for a setup link.');

    const now = Date.now();
    const recent = (asks.get(req.ip ?? '') ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= ASKS_PER_HOUR_PER_IP) throw new HttpError(429, 'Too many requests. Try again in an hour.');
    recent.push(now);
    asks.set(req.ip ?? '', recent);
    if (asks.size > 5000) for (const [k, v] of asks) if (v.every((t) => now - t >= 3_600_000)) asks.delete(k);

    const reply = { sent: true };
    const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = $1', [email]);
    const row = rows[0];
    if (!row || !row.active || !(row.must_set_password || row.temp_password)) {
      // Same time and same answer as a real send, so neither tells a stranger anything.
      await hashPassword(crypto.randomBytes(8).toString('hex'));
      res.json(reply);
      return;
    }

    // Claimed in one statement: two requests at once, or one inside the cool-down, get one password between them.
    const temp = tempPassword();
    const { rows: claimed } = await db.query(
      `UPDATE users SET password_hash = $2, must_set_password = 0, temp_password = 1,
              temp_password_expires_at = DATEADD(HOUR, $3, SYSDATETIMEOFFSET()), temp_password_sent_at = SYSDATETIMEOFFSET(),
              invite_token_hash = NULL, invite_expires_at = NULL
        OUTPUT INSERTED.id
        WHERE id = $1 AND active = 1 AND (must_set_password = 1 OR temp_password = 1)
          AND (temp_password_sent_at IS NULL OR temp_password_sent_at < DATEADD(MINUTE, -$4, SYSDATETIMEOFFSET()))`,
      [row.id, await hashPassword(temp), TEMP_HOURS, COOLDOWN_MINUTES],
    );
    if (!claimed[0]) {
      res.json(reply);
      return;
    }
    try {
      const mail = passwordEmail(row.name, temp, TEMP_HOURS);
      await sendMail(row.email, mail.subject, mail.text, mail.html);
    } catch (e) {
      // Nothing reached the person: put the account back as it was, so a link or another try still works.
      await db.query(
        `UPDATE users SET password_hash = $2, must_set_password = $3, temp_password = $4, temp_password_expires_at = $5,
                temp_password_sent_at = $6, invite_token_hash = $7, invite_expires_at = $8 WHERE id = $1`,
        [row.id, row.password_hash, row.must_set_password, row.temp_password, row.temp_password_expires_at, row.temp_password_sent_at, row.invite_token_hash, row.invite_expires_at],
      );
      console.error(`[mail] could not send the first-sign-in email to ${row.email}: ${(e as Error).message}`);
      throw new HttpError(502, 'The email could not be sent right now. Try again in a few minutes, or ask the PMO for a setup link.');
    }
    await logActivity(db, null, row.id, 'user.password_emailed', { email: row.email });
    res.json(reply);
  }),
);

/** The account a setup link belongs to, if the link still works. */
async function inviteAccount(token: string) {
  const { rows } = await db.query(
    `SELECT * FROM users
      WHERE invite_token_hash = $1 AND invite_expires_at > SYSDATETIMEOFFSET() AND must_set_password = 1 AND active = 1`,
    [hashToken(token)],
  );
  if (!rows[0]) throw new HttpError(410, 'This link has expired or was already used. Ask the PMO for a new one.');
  return rows[0];
}

authRouter.get(
  '/invite/:token',
  route(async (req, res) => {
    const row = await inviteAccount(str(req.params.token, 'Link', 200));
    res.json({ email: row.email, name: row.name, expiresAt: row.invite_expires_at });
  }),
);

/** Opens a setup link: the person chooses a password (typed twice) and is signed in. */
authRouter.post(
  '/activate',
  route(async (req, res) => {
    const row = await inviteAccount(str(req.body?.token, 'Link', 200));
    const password = str(req.body?.password, 'Password', 200);
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `Choose a password of at least ${MIN_PASSWORD} characters.`);
    if (req.body?.confirm !== password) throw new HttpError(400, 'The two passwords do not match.');
    // The WHERE repeats the link check, so two tabs racing on one link set it once.
    // Kept on the account: when the password was set and through whose link. The
    // admin who made a link could open it themselves, so the account's owner
    // sees this in My account and the owner sees it in the activity.
    const { rows } = await db.query(
      `UPDATE users SET password_hash = $3, must_set_password = 0, invite_token_hash = NULL,
              invite_expires_at = NULL, last_login_at = SYSDATETIMEOFFSET(), password_set_at = SYSDATETIMEOFFSET(),
              password_link_by = invite_issued_by, invite_issued_by = NULL
        OUTPUT INSERTED.*
        WHERE id = $1 AND invite_token_hash = $2 AND must_set_password = 1`,
      [row.id, row.invite_token_hash, await hashPassword(password)],
    );
    if (!rows[0]) throw new HttpError(410, 'This link was already used. Sign in with your password.');
    const { rows: by } = await db.query('SELECT name, email FROM users WHERE id = $1', [row.invite_issued_by]);
    await logActivity(db, null, row.id, 'user.activated', {
      email: row.email,
      linkFrom: by[0] ? `${by[0].name} <${by[0].email}>` : 'server log or command line',
      afterReset: Boolean(row.last_login_at),
    });
    const { token, expires } = await createSession(row.id);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, expires });
    res.json({ user: mapUser(rows[0]) });
  }),
);

authRouter.post(
  '/logout',
  route(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password',
  requireAuth,
  route(async (req, res) => {
    const current = str(req.body?.current, 'Current password', 200);
    const next = str(req.body?.next, 'New password', 200);
    if (next.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters for the new password.`);
    if (next === current) throw new HttpError(400, 'Choose a password that is different from the current one.');
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!rows[0]?.password_hash || !(await verifyPassword(current, rows[0].password_hash))) {
      throw new HttpError(400, 'The current password is not correct.');
    }
    await db.query(
      'UPDATE users SET password_hash = $2, password_set_at = SYSDATETIMEOFFSET(), password_link_by = NULL, temp_password = 0, temp_password_expires_at = NULL WHERE id = $1',
      [
        req.user!.id,
        await hashPassword(next),
      ],
    );
    // Sign out every other device that used the old password.
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user!.id, req.cookies?.[SESSION_COOKIE]]);
    res.json({ ok: true });
  }),
);
