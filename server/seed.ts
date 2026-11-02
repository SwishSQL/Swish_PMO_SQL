// Boot-time seeding: reference data only (departments, quarters, roles, the
// owner account). Projects come from the tracker through `npm run import`.

import { db } from './db';
import { INVITE_DAYS, issueInvite, ownerEmail } from './auth';
import { ADMIN_ROLE_ID, COMPANY_DOMAIN, DEFAULT_ROLES, isCompanyEmail } from '../shared/permissions';
import { quarterRange, todayIso } from '../shared/dates';

/** The tracker's categories are the company's own grouping: they become the departments. */
export const DEPARTMENTS: [string, string, string][] = [
  ['TECH', 'Technology', 'التقنية'],
  ['STRAT', 'Strategic', 'استراتيجي'],
  ['SC', 'Supply Chain', 'سلسلة الإمداد'],
  ['OPEX', 'Operational Excellence', 'التميز التشغيلي'],
  ['ERP', 'ERP & Transformation', 'ERP والتحول'],
  ['FIN', 'Finance', 'المالية'],
  ['HR', 'HR', 'الموارد البشرية'],
  ['COST', 'Costing', 'التكاليف'],
  ['CCA', 'Cost Control Audit', 'تدقيق ضبط التكاليف'],
  ['NONE', 'Unassigned', 'غير مصنف'],
  // Added after the tracker import: not one of its categories, but a department of the company. Departments
  // are only inserted when missing, so this appears on the next boot of a running system without touching the rest.
  ['CC', 'Customer Care', 'خدمة العملاء'],
];

export async function seedReference(): Promise<void> {
  for (const [i, [code, name, nameAr]] of DEPARTMENTS.entries()) {
    await db.query(
      'INSERT INTO departments (code, name, name_ar, color_slot) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = $1)',
      [code, name, nameAr, (i % 8) + 1],
    );
  }
  // Three planning years, matching the PMO's 3-year roadmap horizon.
  const year = Number(todayIso().slice(0, 4));
  for (const y of [year - 1, year, year + 1, year + 2]) {
    for (const q of [1, 2, 3, 4]) {
      const { startsOn, endsOn } = quarterRange(y, q);
      await db.query(
        'INSERT INTO quarters (code, year, q, starts_on, ends_on) SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM quarters WHERE code = $1)',
        [`Q${q}-${y}`, y, q, startsOn, endsOn],
      );
    }
  }

  // Roles: the defaults appear once and are the owner's to edit afterwards.
  // Admin is protected and always re-asserted to hold every permission.
  for (const r of DEFAULT_ROLES) {
    const isAdmin = r.id === ADMIN_ROLE_ID;
    await db.query(
      isAdmin
        ? `UPDATE roles SET permissions = $4, protected = 1 WHERE id = $1;
           IF @@ROWCOUNT = 0 INSERT INTO roles (id, name, name_ar, permissions, protected) VALUES ($1, $2, $3, $4, 1)`
        : `INSERT INTO roles (id, name, name_ar, permissions, protected) SELECT $1, $2, $3, $4, 0 WHERE NOT EXISTS (SELECT 1 FROM roles WHERE id = $1)`,
      [r.id, r.name, r.nameAr, JSON.stringify(r.permissions)],
    );
  }

  // Hierarchy change (2026-10): only department heads start projects, so the old Project manager role
  // stops being able to. Done once: after that the owner's edits to roles are left alone.
  const { rows: flag } = await db.query(`INSERT INTO schema_flags (name) OUTPUT INSERTED.name SELECT 'roles-hierarchy-1' WHERE NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = 'roles-hierarchy-1')`);
  if (flag.length) {
    await db.query(
      `UPDATE roles SET permissions = COALESCE((SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(value, 'json') + '"', ',') + ']' FROM OPENJSON(permissions) WHERE value <> 'projects.create'), '[]')
        WHERE id = 'pm'`,
    );
  }
  // A department head named in the tracker is linked to the account of the same name, once and only when
  // exactly one account has it. After that the Departments tab is where it is chosen.
  const { rows: link } = await db.query(`INSERT INTO schema_flags (name) OUTPUT INSERTED.name SELECT 'dept-head-link-1' WHERE NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = 'dept-head-link-1')`);
  if (link.length) {
    await db.query(
      `UPDATE d SET head_user_id = (SELECT u.id FROM users u WHERE LOWER(LTRIM(RTRIM(u.name))) = LOWER(LTRIM(RTRIM(d.head_name))))
         FROM departments d
        WHERE d.head_user_id IS NULL AND d.head_name IS NOT NULL
          AND (SELECT COUNT(*) FROM users u WHERE LOWER(LTRIM(RTRIM(u.name))) = LOWER(LTRIM(RTRIM(d.head_name)))) = 1`,
    );
  }

  // The owner: a protected PMO admin, added without a password. Nobody sits
  // above the owner to send a setup link, so while the account is not set up,
  // each boot writes a fresh link to the server log (readable only by people
  // with access to the hosting project).
  const owner = ownerEmail();
  if (!owner) {
    console.warn("[seed] OWNER_EMAIL is not set. Set it to the owner's @swishhh.net email so someone can sign in.");
    return;
  }
  if (!isCompanyEmail(owner)) {
    console.warn(`[seed] OWNER_EMAIL must be a ${COMPANY_DOMAIN} address. No owner account was created.`);
    return;
  }
  let { rows } = await db.query(
    `UPDATE users SET role_id = $2, active = 1 OUTPUT INSERTED.id, INSERTED.must_set_password, CAST(0 AS BIT) AS inserted WHERE email = $1`,
    [owner, ADMIN_ROLE_ID],
  );
  if (!rows.length) {
    ({ rows } = await db.query(
      `INSERT INTO users (email, name, role_id, title, must_set_password) OUTPUT INSERTED.id, INSERTED.must_set_password, CAST(1 AS BIT) AS inserted VALUES ($1, $2, $3, 'System owner', 1)`,
      [owner, process.env.OWNER_NAME || 'Owner', ADMIN_ROLE_ID],
    ));
  }
  if (rows[0]?.inserted) console.log(`[seed] Added owner ${owner}.`);
  if (rows[0]?.must_set_password) {
    const { token } = await issueInvite(db, rows[0].id, null);
    console.log(`[seed] The owner account is not set up yet. Setup link (valid ${INVITE_DAYS} days, one use): ${setupLink(token)}`);
  }
}

/** The full setup link when the public address is known, else the path to append to it. */
export function setupLink(token: string): string {
  const base = (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, '');
  return `${base}/#/activate/${token}`;
}

export async function runSeeds(): Promise<void> {
  await seedReference();
}
