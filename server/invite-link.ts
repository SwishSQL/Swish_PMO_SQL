// Prints a fresh one-time setup link for an account, for when no admin can
// send one from the app (for example, the owner lost their password).
//
//   npm run invite-link -- someone@swishhh.net
//
// Against production, run it where DATABASE_URL points at the live database
// (e.g. `npm run invite-link -- someone@swishhh.net` on the server). The
// account's password is cleared and its sessions end, exactly like Reset
// password in the app.

import './env';
import { db, initDb } from './db';
import { INVITE_DAYS, issueInvite } from './auth';
import { setupLink } from './seed';

async function main(): Promise<void> {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email) throw new Error('Usage: npm run invite-link -- someone@swishhh.net');
  await initDb();
  const { rows } = await db.query('SELECT id, active FROM users WHERE lower(email) = $1', [email]);
  if (!rows[0]) throw new Error(`No account uses ${email}.`);
  if (!rows[0].active) throw new Error(`${email} is switched off. Switch it back on first.`);
  const token = await db.tx(async (q) => {
    await q.query(
      'UPDATE users SET password_hash = NULL, must_set_password = 1, temp_password = 0, temp_password_expires_at = NULL, temp_password_sent_at = NULL WHERE id = $1',
      [rows[0].id],
    );
    await q.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
    return (await issueInvite(q, rows[0].id, null)).token;
  });
  console.log(`Setup link for ${email} (valid ${INVITE_DAYS} days, one use):`);
  console.log(setupLink(token));
  if (!process.env.APP_URL && !process.env.RAILWAY_PUBLIC_DOMAIN) console.log('(Put the site address in front of the path above.)');
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
