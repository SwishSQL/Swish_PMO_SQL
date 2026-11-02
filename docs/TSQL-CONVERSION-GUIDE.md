# PostgreSQL to T-SQL: the rules used in this port

**Target: SQL Server 2019 (compatibility level 150) or newer.** Nothing that needs 2022 may be used (IS DISTINCT FROM, GREATEST, LEAST, DATETRUNC, GENERATE_SERIES, ...). The test database is created at level 150 so a newer feature fails the tests.

SWiSH PMO (SQL Server edition) is the PostgreSQL edition with its data layer replaced. The client, the business rules and
the HTTP API are the same; every SQL text in `server/` is native T-SQL. This is how each PostgreSQL construct was written.
Use it when you port a later change from the PostgreSQL edition.

## What `server/db.ts` does for you (and only this)

- `$1, $2, ...` stay in the SQL text. They become `@p1, @p2, ...` (never inside a quoted string).
- A JS **array** bound to a parameter is sent as JSON text. Use `x IN (SELECT value FROM OPENJSON($1))` instead of
  `x = ANY($1::int[])`. An empty array is fine (matches nothing).
- A JS **object** bound to a parameter is sent as JSON text (`JSON.stringify`).
- `null` / `undefined` bind as a typed NULL, numbers as INT/BIGINT/FLOAT, booleans as BIT, `Date` as DATETIMEOFFSET,
  `Buffer` as VARBINARY(MAX), strings as NVARCHAR(MAX).
- Rows come back with DATE columns as `'YYYY-MM-DD'` strings, and columns named `permissions`, `detail`, `data`, `areas`,
  `changes`, `snapshot`, `applied` (JSON text in the table) already parsed. A column aliased `something__json` is parsed
  and delivered as `something`.
- `result.rowCount` is the rows affected (or returned).
- A unique-key violation has `error.code === '23505'`, a foreign-key violation `'23503'` (as on PostgreSQL).
- Inside `db.tx(fn)` the queries run one after another on one connection. Do not rely on running two at once.

## Rules

| PostgreSQL | T-SQL |
| --- | --- |
| `now()` | `SYSDATETIMEOFFSET()` |
| `CURRENT_DATE` | `CAST(SYSUTCDATETIME() AS DATE)` (the database ran in UTC) |
| `x::int`, `x::text`, `x::date`, `x::numeric` | `CAST(x AS INT)`, `CAST(x AS NVARCHAR(MAX))`, `CAST(x AS DATE)`, ... Drop casts that only typed a parameter (`$1::int IS NULL` is just `$1 IS NULL`). |
| `count(*)::int` | `COUNT(*)` (already INT) |
| `LIMIT n` / `LIMIT n OFFSET m` | `ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY` (needs ORDER BY), or `SELECT TOP (n)` |
| bare boolean `WHERE active`, `NOT p.archived`, `AND email_notifications` | `WHERE active = 1`, `p.archived = 0`, ... SQL Server has no boolean predicate. `TRUE`/`FALSE` become `1`/`0`. |
| `a IS DISTINCT FROM b` | SQL Server 2022 only, NOT allowed here: `(a <> b OR (a IS NULL AND b IS NOT NULL) OR (a IS NOT NULL AND b IS NULL))` |
| `a \|\| b` | `CONCAT(a, b)` (NULL-safe, like `COALESCE(a,'') + ...`) or `a + b` when neither can be NULL |
| `INSERT ... RETURNING cols` | `INSERT INTO t (...) OUTPUT INSERTED.col VALUES (...)`. `UPDATE ... SET ... OUTPUT INSERTED.col WHERE ...`. `DELETE ... OUTPUT DELETED.col WHERE ...`. |
| `ON CONFLICT (k) DO NOTHING` | `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM t WHERE k = ...)` |
| `ON CONFLICT (k) DO UPDATE SET ...` | `UPDATE t SET ... WHERE k = ...;` then `IF @@ROWCOUNT = 0 INSERT ...` in the same query text, or `MERGE ... WITH (HOLDLOCK)` |
| `ON CONFLICT DO NOTHING RETURNING x` (did it insert?) | `INSERT INTO t (cols) OUTPUT INSERTED.x SELECT ... WHERE NOT EXISTS (...)` |
| `UPDATE t a SET ... FROM u WHERE ...` | `UPDATE a SET ... FROM t a JOIN u ON ... WHERE ...` |
| `to_char(d, 'YYYY-MM-DD')` | `CONVERT(CHAR(10), d, 23)` |
| `(ts AT TIME ZONE 'Asia/Kuwait')::date` | `CAST(ts AT TIME ZONE 'Arab Standard Time' AS DATE)` |
| `d1 - d2` on dates (days) | `DATEDIFF(DAY, d2, d1)` |
| `d + n` / `d - n` (days) | `DATEADD(DAY, n, d)` |
| `now() + ($1 \|\| ' hours')::interval` | `DATEADD(HOUR, $1, SYSDATETIMEOFFSET())` |
| `json_agg(...)`, `json_build_object(...)` | `(SELECT ... FOR JSON PATH)`, aliased `name__json`. Empty result: wrap in `COALESCE((...), '[]')`. |
| `jsonb_array_elements(x)` | `OPENJSON(x)` |
| `x::text LIKE '%a%'` on a JSON column | `x LIKE N'%a%'` |
| `array_agg`, `string_agg(x, ',')` | `STRING_AGG(x, ',')` |
| `GREATEST(a, b)` / `LEAST` | SQL Server 2022 only, NOT allowed here: `CASE WHEN a >= b THEN a ELSE b END` (mind NULLs) |
| `WITH RECURSIVE` | `WITH` (no RECURSIVE keyword) |
| `DISTINCT ON (k)` | `ROW_NUMBER() OVER (PARTITION BY k ORDER BY ...) = 1` in a subquery |
| `ORDER BY x NULLS LAST` | `ORDER BY CASE WHEN x IS NULL THEN 1 ELSE 0 END, x` |
| `substring(code from 'PRJ-(\d+)')::int` | `TRY_CAST(SUBSTRING(code, 5, 20) AS INT)` when code LIKE 'PRJ-%' |
| `FILTER (WHERE c)` | `SUM(CASE WHEN c THEN 1 ELSE 0 END)` |
| `lower(trim(x))` | `LOWER(LTRIM(RTRIM(x)))` |
| `SELECT col AS existing_col` | never alias an expression with the name of a column already selected: the driver turns the duplicate into an array |
| `SELECT a.*, b.*` with shared column names | name the columns: duplicates become arrays |
| `ILIKE` | `LIKE` (the database collation is case-insensitive) |
| `FOR UPDATE` | `WITH (UPDLOCK, ROWLOCK)` on the table in FROM |

## Traps

- `OUTPUT` without `INTO` is refused (error 334) on a table that has an enabled trigger for that statement. The delete
  triggers (tasks, projects, users, departments, ...) mean `DELETE ... OUTPUT` on those tables must be written as
  `DECLARE @gone TABLE (...); DELETE ... OUTPUT DELETED.id INTO @gone ...; SELECT * FROM @gone`.
- A semicolon is a statement separator in T-SQL, not a comment character. Keep them out of `--` comments in `.sql` files that
  are split by tools, and write `;` before `WITH` when a CTE follows another statement.
- `NVARCHAR(MAX)` cannot be an index key and cannot be compared with `=` in some contexts (it can: but not in `GROUP BY`
  of an indexed view). Only indexed or unique text is `NVARCHAR(450)`.
- `COUNT(*)` is INT, `COUNT_BIG` is BIGINT (a string in JS), `LEN()` of an NVARCHAR(MAX) is BIGINT.
- A trailing comma or an unknown column is found only when the statement runs: call the changed route.
- Identity: inserting an explicit id needs `SET IDENTITY_INSERT t ON` in the same batch.
