// A full backup as one .sql file (T-SQL), kept outside the server by whoever downloads it.
//
// Restore into a database where SWiSH PMO has started at least once (so the
// tables exist), with:
//   sqlcmd -S <server> -d <database> -U <user> -b -i swish-pmo-backup-<date>.sql
// (or open the file in SSMS and execute it). The file is plain ASCII, so it
// reads the same under any code page. It is ONE batch with no GO: SET XACT_ABORT
// ON and a single transaction replace every row, all or nothing. Rows go in
// through OPENJSON with a column list typed from the table, parents before
// children (the order comes from sys.foreign_keys). A foreign key that points
// back up a cycle (users <-> departments) is switched off while the rows load
// and checked again at the end. Identity values are kept and reseeded.
//
// Not in the file: sessions, password hashes and setup-link tokens. A leaked
// backup gives nobody a way in. After a restore every account is "not set up":
// the owner's setup link appears in the boot log, and the owner sends the rest
// new links from Users & permissions.

import { db } from './db';

const SKIP = new Set(['sessions']);

/** Columns the driver would parse as JSON on the way out: read them under another name to keep the stored text. */
const JSON_COLUMNS = new Set(['permissions', 'detail', 'data', 'areas', 'changes', 'snapshot', 'applied']);

/** Parents before children, so foreign keys hold as rows go in. */
function order(tables: string[], edges: { child: string; parent: string }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, path: Set<string>) => {
    if (seen.has(t) || path.has(t)) return;
    path.add(t);
    for (const e of edges) if (e.child === t && e.parent !== t && tables.includes(e.parent)) visit(e.parent, path);
    seen.add(t);
    out.push(t);
  };
  for (const t of [...tables].sort()) visit(t, new Set());
  return out;
}

const ident = (name: string) => `[${name.replace(/\]/g, ']]')}]`;
const full = (name: string) => `[dbo].${ident(name)}`;
/** A T-SQL string literal, in pieces the script joins (the whole text is ASCII: non-ASCII characters are \uXXXX escapes). */
const lit = (s: string) => `N'${s.replace(/'/g, "''")}'`;

interface Column {
  name: string;
  type: string;
  length: number;
  prec: number;
  scl: number;
  identity: boolean;
}

/** The type a column is read with in OPENJSON WITH. Binary travels as hex text, converted back in the SELECT. */
function withType(c: Column): string {
  const size = (n: number) => (n === -1 ? 'MAX' : String(n));
  switch (c.type) {
    case 'nvarchar':
    case 'nchar':
      return `${c.type.toUpperCase()}(${size(c.length === -1 ? -1 : c.length / 2)})`;
    case 'varchar':
    case 'char':
      return `${c.type.toUpperCase()}(${size(c.length)})`;
    case 'varbinary':
    case 'binary':
      return 'NVARCHAR(MAX)';
    case 'decimal':
    case 'numeric':
      return `DECIMAL(${c.prec},${c.scl})`;
    case 'datetimeoffset':
    case 'datetime2':
    case 'time':
      return `${c.type.toUpperCase()}(${c.scl})`;
    default:
      return c.type.toUpperCase();
  }
}

const isBinary = (c: Column) => c.type === 'varbinary' || c.type === 'binary';

/** How the column is read out of the table: dates and times as text exactly as stored (style 126 keeps the offset), binary as hex. */
function selectExpr(c: Column): string {
  const n = ident(c.name);
  if (isBinary(c)) return `CONVERT(VARCHAR(MAX), ${n}, 2) AS ${n}`;
  if (c.type === 'date') return `CONVERT(CHAR(10), ${n}, 23) AS ${n}`;
  if (c.type === 'datetimeoffset') return `CONVERT(VARCHAR(40), ${n}, 126) AS ${n}`;
  if (c.type === 'datetime2' || c.type === 'datetime') return `CONVERT(VARCHAR(40), ${n}, 126) AS ${n}`;
  if (JSON_COLUMNS.has(c.name)) return `CAST(${n} AS NVARCHAR(MAX)) AS ${ident(`raw_${c.name}`)}`;
  return n;
}

/** JSON text with every non-ASCII character written as \uXXXX, so the script is pure ASCII. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function buildBackup(): Promise<{ sql: string; counts: Record<string, number> }> {
  const { rows: tableRows } = await db.query<{ name: string }>(`SELECT t.name AS [name] FROM sys.tables t WHERE SCHEMA_NAME(t.schema_id) = 'dbo'`);
  const all = tableRows.map((r) => r.name);
  const { rows: edges } = await db.query<{ fk: string; child: string; parent: string }>(
    `SELECT k.name AS fk, OBJECT_NAME(k.parent_object_id) AS child, OBJECT_NAME(k.referenced_object_id) AS parent
       FROM sys.foreign_keys k WHERE SCHEMA_NAME(k.schema_id) = 'dbo'`,
  );
  // Every table, sessions too: rows are deleted child first, and loaded parent first (sessions is not loaded).
  const sorted = order(all, edges);
  const tables = sorted.filter((t) => !SKIP.has(t));
  const rank = new Map(sorted.map((t, i) => [t, i]));
  // A foreign key whose parent comes after its child: a cycle. It is off while the rows load.
  const deferred = edges.filter((e) => e.child !== e.parent && rank.get(e.parent)! > rank.get(e.child)!);

  const counts: Record<string, number> = {};
  const loads: string[] = [];
  const checks: string[] = [];
  for (const table of tables) {
    const { rows: colRows } = await db.query<{ name: string; type: string; length: number; prec: number; scl: number; identity: boolean }>(
      `SELECT c.name AS [name], ty.name AS [type], c.max_length AS [length], c.precision AS prec, c.scale AS scl, c.is_identity AS [identity]
         FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID($1) AND c.is_computed = 0 ORDER BY c.column_id`,
      [full(table)],
    );
    const cols: Column[] = colRows.map((c) => ({ name: c.name, type: c.type, length: c.length, prec: c.prec, scl: c.scl, identity: !!c.identity }));
    const identity = cols.find((c) => c.identity);
    const { rows } = await db.query(`SELECT ${cols.map(selectExpr).join(', ')} FROM ${full(table)}${identity ? ` ORDER BY ${ident(identity.name)}` : ''}`);
    let data = rows.map((r: Record<string, unknown>) => {
      const o: Record<string, unknown> = {};
      for (const c of cols) o[c.name] = JSON_COLUMNS.has(c.name) ? r[`raw_${c.name}`] ?? null : r[c.name] ?? null;
      return o;
    });
    if (table === 'users') {
      data = data.map((u) => ({ ...u, password_hash: null, must_set_password: true, invite_token_hash: null, invite_expires_at: null, temp_password: false, temp_password_expires_at: null, temp_password_sent_at: null }));
    }
    counts[table] = data.length;
    if (!data.length) continue;

    const json = asciiJson(data);
    const list = cols.map((c) => ident(c.name)).join(', ');
    const select = cols.map((c) => (isBinary(c) ? `CONVERT(VARBINARY(MAX), ${ident(c.name)}, 2)` : ident(c.name))).join(', ');
    const withList = cols.map((c) => `${ident(c.name)} ${withType(c)} '$."${c.name}"'`).join(', ');
    const lines = [`-- ${table}: ${data.length} rows`];
    for (let i = 0; i < json.length; i += 3000) lines.push(`${i === 0 ? 'SET @j = ' : 'SET @j = @j + '}${lit(json.slice(i, i + 3000))};`);
    if (identity) lines.push(`SET IDENTITY_INSERT ${full(table)} ON;`);
    lines.push(`INSERT INTO ${full(table)} (${list}) SELECT ${select} FROM OPENJSON(@j) WITH (${withList});`);
    if (identity) {
      lines.push(`SET IDENTITY_INSERT ${full(table)} OFF;`);
      const max = Math.max(...data.map((r) => Number(r[identity.name])));
      lines.push(`DBCC CHECKIDENT (${lit(full(table))}, RESEED, ${max}) WITH NO_INFOMSGS;`);
    }
    loads.push(lines.join('\n'));
    checks.push(`IF (SELECT COUNT(*) FROM ${full(table)}) <> ${data.length} THROW 50000, ${lit(`Backup restore: wrong row count in ${table}`)}, 1;`);
  }

  const stamp = new Date().toISOString();
  const out: string[] = [
    `-- SWiSH PMO backup (SQL Server), taken ${stamp}`,
    `-- Rows: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')}`,
    '--',
    '-- Restore into a database where SWiSH PMO has started once (the tables exist):',
    '--   sqlcmd -S server -d database -U user -b -i this-file.sql',
    '-- It REPLACES every row in that database, in one transaction (all or nothing).',
    '-- Passwords are not in this file. After a restore every account needs a new setup link.',
    '',
    // sqlcmd starts with QUOTED_IDENTIFIER off (unless run with -I), and the filtered indexes refuse a write then.
    'SET QUOTED_IDENTIFIER ON;',
    'SET ANSI_NULLS ON;',
    'SET ANSI_PADDING ON;',
    'SET ANSI_WARNINGS ON;',
    'SET ARITHABORT ON;',
    'SET CONCAT_NULL_YIELDS_NULL ON;',
    'SET NOCOUNT ON;',
    'SET XACT_ABORT ON;',
    'BEGIN TRANSACTION;',
    'DECLARE @j NVARCHAR(MAX);',
    '',
  ];
  for (const e of deferred) out.push(`ALTER TABLE ${full(e.child)} NOCHECK CONSTRAINT ${ident(e.fk)};`);
  out.push('', '-- Empty every table, children first (the delete triggers do the cascades).');
  for (const t of [...sorted].reverse()) out.push(`DELETE FROM ${full(t)};`);
  out.push('');
  out.push(...loads.flatMap((l) => [l, '']));
  for (const e of deferred) out.push(`ALTER TABLE ${full(e.child)} WITH CHECK CHECK CONSTRAINT ${ident(e.fk)};`);
  out.push(...checks, 'COMMIT TRANSACTION;', `PRINT ${lit('SWiSH PMO backup restored.')};`, '');
  return { sql: out.join('\n'), counts };
}
