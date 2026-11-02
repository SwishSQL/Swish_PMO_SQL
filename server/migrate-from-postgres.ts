// One-time data move from the PostgreSQL edition to this one.
//
//   PG_SOURCE_URL=postgres://user:password@host:port/db npm run migrate:from-postgres [-- --replace]
//
// The target is the SQL Server in .env (MSSQL_* or DATABASE_URL). The source is only read, inside one
// REPEATABLE READ READ ONLY snapshot. Every table of this edition is copied by name, column for column, in
// one SQL Server transaction: all of it or none of it. Passwords, setup links and everything else stay as they
// are, so people sign in as before. Open sign-in sessions are not copied (everyone signs in once).
// A target that already holds rows is refused unless --replace is given, which empties it first.
// Row counts are compared afterwards and any difference fails (and so rolls back) the run.

import './env';
import { Pool, types } from 'pg';
import { db, initDb } from './db';

// DATE stays text ('YYYY-MM-DD'). Everything else keeps the driver's defaults: timestamps as Date, jsonb parsed.
types.setTypeParser(1082, (v) => v);

const SKIP = new Set(['sessions']);
const BATCH = 200;
const q = (name: string) => `[${name.replace(/]/g, ']]')}]`;

interface Column {
  name: string;
  type: string;
  maxLength: number;
  precision: number;
  scale: number;
  identity: boolean;
}

/** The column's type as OPENJSON ... WITH wants it written. */
function withType(c: Column): string {
  switch (c.type) {
    case 'nvarchar':
    case 'varchar':
      return 'NVARCHAR(MAX)';
    case 'varbinary':
      return 'VARBINARY(MAX)';
    case 'decimal':
    case 'numeric':
      return `DECIMAL(${c.precision},${c.scale})`;
    case 'datetimeoffset':
    case 'datetime2':
      return `${c.type.toUpperCase()}(${c.scale})`;
    default:
      return c.type.toUpperCase();
  }
}

/** A value as OPENJSON reads it back: bytes as base64, jsonb as its text, Dates as ISO text. */
function plain(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

async function main(): Promise<void> {
  const url = process.env.PG_SOURCE_URL;
  if (!url) throw new Error('PG_SOURCE_URL is not set (the PostgreSQL connection string to read from).');
  const replace = process.argv.includes('--replace');
  await initDb();

  const { rows: tableRows } = await db.query<{ name: string }>(`SELECT name FROM sys.tables WHERE is_ms_shipped = 0 ORDER BY name`);
  const tables = tableRows.map((t) => t.name).filter((t) => !SKIP.has(t));
  const columns = new Map<string, Column[]>();
  for (const t of tables) {
    const { rows } = await db.query<any>(
      `SELECT c.name, ty.name AS type, c.max_length, c.precision, c.scale, c.is_identity
         FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID($1) AND c.is_computed = 0 ORDER BY c.column_id`,
      [`dbo.${t}`],
    );
    columns.set(t, rows.map((r) => ({ name: r.name, type: r.type, maxLength: r.max_length, precision: r.precision, scale: r.scale, identity: !!r.is_identity })));
  }

  if (!replace) {
    for (const t of tables) {
      const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(t)}`);
      if (rows[0].n > 0) throw new Error(`${t} already holds ${rows[0].n} rows. Run again with --replace to empty the target first.`);
    }
  }

  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) ? undefined : { rejectUnauthorized: false }, max: 1 });
  const src = await pool.connect();
  try {
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: have } = await src.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const inSource = new Set(have.map((r) => r.table_name as string));

    const report: string[] = [];
    await db.tx(async (tx) => {
      // The foreign keys form cycles (a department's head is a user, a user belongs to a department), so they and the delete
      // triggers are switched off while the rows go in, then every constraint is checked again in full.
      for (const t of tables) await tx.query(`ALTER TABLE ${q(t)} NOCHECK CONSTRAINT ALL; ALTER TABLE ${q(t)} DISABLE TRIGGER ALL`);
      if (replace) for (const t of [...tables, ...SKIP]) await tx.query(`DELETE FROM ${q(t)}`);

      for (const t of tables) {
        const cols = columns.get(t)!;
        if (!inSource.has(t)) {
          report.push(`${t}: not in the source, left empty`);
          continue;
        }
        const { rows } = await src.query(`SELECT * FROM ${q(t).replace(/\[|\]/g, '"')}`);
        const known = new Set(cols.map((c) => c.name));
        const extra = rows.length ? Object.keys(rows[0]).filter((k) => !known.has(k)) : [];
        if (extra.length) throw new Error(`${t}: the source has columns this edition does not (${extra.join(', ')}). Port that change first.`);
        const present = rows.length ? cols.filter((c) => c.name in rows[0]) : [];
        const identity = present.some((c) => c.identity);
        if (rows.length) {
          const list = present.map((c) => q(c.name)).join(', ');
          const spec = present.map((c) => `${q(c.name)} ${withType(c)}`).join(', ');
          const sqlText = `${identity ? `SET IDENTITY_INSERT ${q(t)} ON; ` : ''}INSERT INTO ${q(t)} (${list}) SELECT ${list} FROM OPENJSON($1) WITH (${spec})${identity ? `; SET IDENTITY_INSERT ${q(t)} OFF` : ''}`;
          for (let i = 0; i < rows.length; i += BATCH) {
            const chunk = rows.slice(i, i + BATCH).map((r) => Object.fromEntries(present.map((c) => [c.name, plain(r[c.name])])));
            await tx.query(sqlText, [chunk]);
          }
          if (identity) {
            const id = present.find((c) => c.identity)!.name;
            await tx.query(`DECLARE @m INT = (SELECT MAX(${q(id)}) FROM ${q(t)}); IF @m IS NOT NULL DBCC CHECKIDENT ('dbo.${t}', RESEED, @m) WITH NO_INFOMSGS`);
          }
        }
        const { rows: back } = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(t)}`);
        if (back[0].n !== rows.length) throw new Error(`${t}: ${rows.length} rows in the source, ${back[0].n} arrived`);
        report.push(`${t}: ${rows.length}`);
      }

      for (const t of tables) await tx.query(`ALTER TABLE ${q(t)} WITH CHECK CHECK CONSTRAINT ALL; ALTER TABLE ${q(t)} ENABLE TRIGGER ALL`);
    });
    console.log(report.join('\n'));
    console.log(`Done: ${tables.length} tables checked, every row counted on both sides.`);
  } finally {
    await src.query('ROLLBACK').catch(() => undefined);
    src.release();
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Migration failed, nothing was written:', error.message ?? error);
    process.exit(1);
  });
