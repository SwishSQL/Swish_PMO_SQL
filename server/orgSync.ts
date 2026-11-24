import type { Queryable } from './db';
import { mergeName } from './people';

// The org chart is the reference for who someone is: their full name, department and position. An account (found by
// the same email) follows it. Edits made on the Users page are copied back, so the two never drift apart.

/** The account of this person takes the org chart's name, department and position. Returns what changed. */
export async function syncAccountFromStaff(q: Queryable, staffId: number): Promise<string[]> {
  const { rows } = await q.query(
    `SELECT s.name, s.department_id, s.position, u.id AS uid, u.name AS uname, u.department_id AS udept, u.title AS utitle
       FROM staff s JOIN users u ON LOWER(u.email) = LOWER(s.email)
      WHERE s.id = $1 AND s.email IS NOT NULL`,
    [staffId],
  );
  const r = rows[0];
  if (!r) return [];
  const changed: string[] = [];
  if (r.name && r.name !== r.uname) {
    await q.query('UPDATE users SET name = $2 WHERE id = $1', [r.uid, r.name]);
    // The plans name people as text: the old spelling follows.
    await mergeName(q, r.uname, r.name);
    changed.push('name');
  }
  if (r.department_id && r.department_id !== r.udept) {
    // Someone who heads another department stays in it (Ravi heads Transformation while the chart lists Finance).
    const { rows: heads } = await q.query('SELECT 1 FROM departments WHERE head_user_id = $1 AND id <> $2', [r.uid, r.department_id]);
    if (!heads.length) {
      await q.query('UPDATE users SET department_id = $2 WHERE id = $1', [r.uid, r.department_id]);
      changed.push('department');
    }
  }
  if (r.position && r.position !== r.utitle) {
    await q.query('UPDATE users SET title = $2 WHERE id = $1', [r.uid, r.position]);
    changed.push('title');
  }
  return changed;
}

/** An account edited on the Users page: its person in the org chart takes the same name, department and position. */
export async function syncStaffFromAccount(q: Queryable, userId: number, emailFrom?: string | null): Promise<void> {
  const { rows } = await q.query('SELECT name, email, department_id, title FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u) return;
  if (emailFrom && emailFrom.toLowerCase() !== String(u.email).toLowerCase()) {
    await q.query('UPDATE staff SET email = $2, updated_at = SYSDATETIMEOFFSET() WHERE LOWER(email) = LOWER($1)', [emailFrom, u.email]);
  }
  await q.query(
    `UPDATE staff SET name = $2, department_id = COALESCE($3, department_id), position = COALESCE($4, position), updated_at = SYSDATETIMEOFFSET()
      WHERE LOWER(email) = LOWER($1)`,
    [u.email, u.name, u.department_id, u.title || null],
  );
}
