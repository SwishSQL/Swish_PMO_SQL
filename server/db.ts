import fs from 'node:fs';
import path from 'node:path';
import sql from 'mssql';

// SQL Server data layer. The rest of the server calls `db.query(text, params)` and `db.tx(fn)`, as it did on
// PostgreSQL, and the text it sends is written in T-SQL. Two conveniences keep that text readable:
//   * `$1, $2, ...` are the parameters (turned into @p1, @p2, ... here, never inside a quoted string);
//   * a JS array bound to a parameter reaches the server as a JSON text, so `x IN (SELECT value FROM OPENJSON($1))`
//     takes a list of ids of any length (SQL Server allows 2100 parameters, a list may be longer).
// Rows come back the way the PostgreSQL edition returned them: DATE columns as 'YYYY-MM-DD' strings (never a JS Date,
// which would shift a milestone a day in some time zones), JSON columns parsed.
//
// Connection: DATABASE_URL (sqlserver://user:password@host:1433/database) or MSSQL_HOST / MSSQL_PORT / MSSQL_USER /
// MSSQL_PASSWORD / MSSQL_DATABASE. MSSQL_ENCRYPT=true turns TLS on, MSSQL_TRUST_CERT=false makes the certificate checked.

export interface QueryResult<R = any> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/** Columns that hold JSON text. They are parsed on the way out (the PostgreSQL driver did it for jsonb). */
const JSON_COLUMNS = new Set(['permissions', 'detail', 'data', 'areas', 'changes', 'snapshot', 'applied', 'request', 'tours_seen']);

function config(): sql.config {
  const url = process.env.DATABASE_URL || process.env.MSSQL_URL;
  const options = {
    encrypt: process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: process.env.MSSQL_TRUST_CERT !== 'false',
    enableArithAbort: true,
    useUTC: true,
    instanceName: process.env.MSSQL_INSTANCE || undefined,
  };
  const pool = { max: Number(process.env.MSSQL_POOL_MAX ?? 10), min: 0, idleTimeoutMillis: 30_000 };
  if (url && /^(sqlserver|mssql):\/\//i.test(url)) {
    const u = new URL(url.replace(/^sqlserver:/i, 'mssql:'));
    return {
      server: decodeURIComponent(u.hostname),
      port: u.port ? Number(u.port) : 1433,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
      options,
      pool,
      requestTimeout: 60_000,
    };
  }
  if (!process.env.MSSQL_HOST && !process.env.MSSQL_DATABASE) {
    throw new Error('No SQL Server connection. Set DATABASE_URL (sqlserver://user:password@host:1433/database) or MSSQL_HOST, MSSQL_USER, MSSQL_PASSWORD and MSSQL_DATABASE.');
  }
  return {
    server: process.env.MSSQL_HOST || 'localhost',
    port: Number(process.env.MSSQL_PORT || 1433),
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    database: process.env.MSSQL_DATABASE || 'swish_pmo',
    options,
    pool,
    requestTimeout: 60_000,
  };
}

/** A name that is safe to put inside [brackets] in a statement that cannot take parameters (CREATE DATABASE, CREATE LOGIN). */
function ident(name: string): string {
  if (!name || /[\x00-\x1f]/.test(name)) throw new Error(`Not a usable SQL Server name: ${JSON.stringify(name)}`);
  return `[${name.replace(/]/g, ']]')}]`;
}
const literal = (text: string) => `N'${text.replace(/'/g, "''")}'`;

/**
 * First start on a new server: the database (and, when MSSQL_ADMIN_USER / MSSQL_ADMIN_PASSWORD are given, the application's
 * login with db_owner on it) does not exist yet. Creates what is missing, through `master`. Without the admin settings the
 * application's own login is used, which works when it may create databases (dbcreator). MSSQL_AUTO_CREATE=false turns it off.
 */
async function provision(cfg: sql.config, original: Error): Promise<void> {
  const admin = process.env.MSSQL_ADMIN_USER;
  const database = cfg.database as string;
  const appUser = cfg.user as string | undefined;
  const master = new sql.ConnectionPool({
    ...cfg,
    database: 'master',
    user: admin || cfg.user,
    password: admin ? process.env.MSSQL_ADMIN_PASSWORD : cfg.password,
    pool: { max: 1, min: 0 },
  });
  master.on('error', () => undefined);
  try {
    await master.connect();
    await master.request().batch(`IF DB_ID(${literal(database)}) IS NULL CREATE DATABASE ${ident(database)};`);
    if (admin && appUser && appUser.toLowerCase() !== admin.toLowerCase()) {
      const login = `IF SUSER_ID(${literal(appUser)}) IS NULL CREATE LOGIN ${ident(appUser)} WITH PASSWORD = ${literal(cfg.password ?? '')}, CHECK_POLICY = OFF;`;
      await master.request().batch(login);
      await master.request().batch(
        `USE ${ident(database)};\n` +
          `IF USER_ID(${literal(appUser)}) IS NULL CREATE USER ${ident(appUser)} FOR LOGIN ${ident(appUser)};\n` +
          `ALTER ROLE db_owner ADD MEMBER ${ident(appUser)};`,
      );
    }
    console.log(`[db] created database ${database}${admin ? ' and its login' : ''} on first start`);
  } catch (error: any) {
    throw new Error(
      `Cannot open database "${database}" as ${appUser} (${original.message}) and could not create it (${error.message}). ` +
        'Check MSSQL_USER / MSSQL_PASSWORD, or ask a DBA to create the database and give the login db_owner on it, or set ' +
        'MSSQL_ADMIN_USER and MSSQL_ADMIN_PASSWORD (a login that may create databases and logins) for the first start.',
    );
  } finally {
    await master.close().catch(() => undefined);
  }
}

let poolPromise: Promise<sql.ConnectionPool> | null = null;
function pool(): Promise<sql.ConnectionPool> {
  poolPromise ??= (async () => {
    const cfg = config();
    const open = async () => {
      const p = new sql.ConnectionPool(cfg);
      // An idle connection dropped by the server emits 'error'. Unheard, that event crashes the process.
      p.on('error', (error) => console.error('[db] connection error', error.message));
      return p.connect();
    };
    try {
      try {
        return await open();
      } catch (error: any) {
        const code = error?.originalError?.number ?? error?.number;
        // A database that does not exist is reported as 4060 or, more often, as a plain "Login failed" (18456, the reason
        // is hidden from the client). Either way try `master`: if the login is simply wrong that fails too, with both messages.
        const fixable = error?.code === 'ELOGIN' || code === 4060 || code === 18456 || /Cannot open database/i.test(error?.message ?? '');
        if (!fixable || process.env.MSSQL_AUTO_CREATE === 'false' || process.env.SKIP_SCHEMA === '1') throw error;
        await provision(cfg, error);
        return await open();
      }
    } catch (error) {
      poolPromise = null;
      throw error;
    }
  })();
  return poolPromise;
}

/** `$1` -> `@p1`, leaving anything inside a quoted string alone. */
export function placeholders(text: string): string {
  return text
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.replace(/\$(\d+)/g, '@p$1')))
    .join('');
}

function bind(request: sql.Request, params: unknown[]) {
  params.forEach((value, i) => {
    const name = `p${i + 1}`;
    if (value === undefined || value === null) request.input(name, sql.VarChar, null);
    else if (Buffer.isBuffer(value)) request.input(name, sql.VarBinary(sql.MAX), value);
    else if (value instanceof Date) request.input(name, sql.DateTimeOffset, value);
    else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) request.input(name, sql.NVarChar(sql.MAX), JSON.stringify(value));
    else if (typeof value === 'boolean') request.input(name, sql.Bit, value);
    else if (typeof value === 'number') {
      if (Number.isInteger(value) && Math.abs(value) <= 2147483647) request.input(name, sql.Int, value);
      else request.input(name, Number.isInteger(value) ? sql.BigInt : sql.Float, value);
    } else request.input(name, sql.NVarChar(sql.MAX), String(value));
  });
}

/** A unique key or a foreign key refused: the PostgreSQL codes the server code knows (23505, 23503). */
function named(error: any): Error {
  const number = error?.number ?? error?.originalError?.info?.number;
  if (number === 2627 || number === 2601) error.code = '23505';
  else if (number === 547) error.code = '23503';
  return error;
}

function shape(result: sql.IResult<any>): QueryResult {
  const columns = (result.recordset as any)?.columns as Record<string, { type: unknown }> | undefined;
  const rows: any[] = result.recordset ? [...result.recordset] : [];
  if (columns && rows.length) {
    const dates = Object.keys(columns).filter((c) => columns[c].type === sql.Date);
    const json = Object.keys(columns).filter((c) => JSON_COLUMNS.has(c) || c.endsWith('__json'));
    for (const row of rows) {
      for (const c of dates) if (row[c] instanceof Date) row[c] = row[c].toISOString().slice(0, 10);
      for (const c of json) {
        if (typeof row[c] !== 'string') continue;
        try {
          const parsed = JSON.parse(row[c]);
          if (c.endsWith('__json')) {
            delete row[c];
            row[c.slice(0, -6)] = parsed;
          } else row[c] = parsed;
        } catch {
          /* not JSON after all: leave it as it came */
        }
      }
    }
  }
  return { rows, rowCount: (result.rowsAffected ?? []).reduce((a, b) => a + b, 0) || rows.length };
}

async function run(request: sql.Request, text: string, params: unknown[]): Promise<QueryResult> {
  bind(request, params);
  try {
    return shape(await request.query(placeholders(text)));
  } catch (error) {
    throw named(error);
  }
}

let ready = false;

export const db: Queryable & { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> } = {
  query: async (text, params = []) => run((await pool()).request(), text, params),
  tx: async (fn) => {
    const transaction = new sql.Transaction(await pool());
    await transaction.begin();
    // One connection runs one request at a time: queries made inside a transaction queue up behind each other.
    let tail: Promise<unknown> = Promise.resolve();
    const q: Queryable = {
      query: (text, params = []) => {
        const next = tail.then(() => run(new sql.Request(transaction), text, params));
        tail = next.catch(() => undefined);
        return next as Promise<any>;
      },
    };
    try {
      const result = await fn(q);
      await tail;
      await transaction.commit();
      return result;
    } catch (error) {
      await tail;
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  },
};

export function dbKind(): 'sqlserver' {
  return 'sqlserver';
}

/** The schema file lives in sql/ at the root of the project, wherever the server runs from (source or dist). */
function schemaFile(): string {
  for (const dir of [path.resolve(__dirname, '../sql'), path.resolve(__dirname, '../../sql')]) {
    const file = path.join(dir, 'schema.sql');
    if (fs.existsSync(file)) return file;
  }
  throw new Error('sql/schema.sql was not found next to the server.');
}

/** Connects, and creates whatever of the schema is missing. SKIP_SCHEMA=1 when a DBA runs sql/schema.sql by hand. */
export async function initDb(): Promise<void> {
  await pool();
  if (!ready && process.env.SKIP_SCHEMA !== '1') {
    const batches = fs
      .readFileSync(schemaFile(), 'utf8')
      .split(/^\s*GO\s*$/im)
      .map((b) => b.trim())
      .filter(Boolean);
    // On a connection of its own that is closed afterwards: the file starts with SET NOCOUNT ON, which would stay on for
    // whichever pooled connection ran it and make that connection report no row counts for the rest of its life.
    const setup = new sql.ConnectionPool({ ...config(), pool: { max: 1, min: 0 } });
    setup.on('error', (error) => console.error('[db] connection error', error.message));
    await setup.connect();
    try {
      for (const batch of batches) await setup.request().batch(batch);
    } finally {
      await setup.close().catch(() => undefined);
    }
  }
  ready = true;
}
