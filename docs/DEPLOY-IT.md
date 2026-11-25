# SWiSH PMO (SQL Server edition): hand-over for IT

This is the same application as the PostgreSQL edition (React client, Node/Express server, same screens, rules and API).
Only the database layer is different: it runs on **Microsoft SQL Server 2019 or newer**. Nothing else in the company
needs to change to run it.

## What you need

| | |
| --- | --- |
| Node.js | 22.x |
| SQL Server | 2019 or newer, SQL authentication enabled (mixed mode) and TCP enabled |
| A database | none to prepare: the server creates it (and every table, trigger and index) on its first start |
| A login | one that may create databases (`dbcreator`), or an administrator login for the first start only (step 1) |
| A port | any free one, set with `PORT` (default 8090) |
| Mail | a mailbox for the system if the emails are wanted (optional, see `.env.example`) |

The server needs no other service. The first start creates every table, index and trigger (`sql/schema.sql`, safe to run
again at every start).

## Steps

1. **Nothing to create by hand.** Put the connection in `.env` (step 3). On its first start the server creates the database
   `MSSQL_DATABASE` if it is missing. Two ways to give it the right to do that:

   - set `MSSQL_ADMIN_USER` / `MSSQL_ADMIN_PASSWORD` (any administrator login, e.g. `sa`): the server then also creates the
     application login `MSSQL_USER` / `MSSQL_PASSWORD` with `db_owner` on the new database, and uses that login from then on;
     delete the two admin lines from `.env` after the first start; or
   - give `MSSQL_USER` the `dbcreator` server role, and it creates the database it then owns.

   If you prefer to prepare everything yourself, this is what the server would do (SSMS or sqlcmd, as an administrator):

   ```sql
   CREATE DATABASE swish_pmo;
   GO
   CREATE LOGIN pmo_app WITH PASSWORD = '<CHOOSE-A-STRONG-PASSWORD>', CHECK_POLICY = ON;
   GO
   USE swish_pmo;
   CREATE USER pmo_app FOR LOGIN pmo_app;
   ALTER ROLE db_owner ADD MEMBER pmo_app;
   GO
   ```

   If the application login must not own the database, run `sql/schema.sql` yourself as an administrator (it is plain
   T-SQL, batches separated by `GO`), give the login read, write and execute rights, and start the server with
   `SKIP_SCHEMA=1`.

2. Get the code, install and build:

   ```bash
   npm ci
   npm run build
   ```

3. Copy `.env.example` to `.env` next to `package.json` and fill it in. The minimum:

   ```
   MSSQL_HOST=<sql server name or address>
   MSSQL_PORT=1433
   MSSQL_USER=pmo_app
   MSSQL_PASSWORD=<the password>
   MSSQL_DATABASE=swish_pmo
   MSSQL_ENCRYPT=false          # true if the server requires TLS
   MSSQL_TRUST_CERT=true        # false when the server has a certificate the machine trusts
   PORT=<the port>
   APP_URL=https://<the address people will use>
   OWNER_EMAIL=<the owner's @swishhh.net address, or several separated by commas>
   OWNER_NAME=<their name, or several separated by commas in the same order>
   ```

   (`DATABASE_URL=sqlserver://user:password@host:1433/database` works instead of the separate `MSSQL_*` settings.)

4. Start it: `npm start` (a Windows service, `pm2`, or IIS with iisnode / a reverse proxy to the port, as with the other
   systems). Check `http://<server>:<port>/api/health`: it answers `{"ok":true,"db":"sqlserver"}` only when the database
   answers.

5. The first start prints each owner's one-time setup link (`/#/activate/<token>`) in the log. Each owner opens theirs, chooses a
   password, and adds the other people from **Users & permissions**. No password is ever kept in code or in `.env`.

## Moving the data from the PostgreSQL edition

The running system keeps its data in PostgreSQL (Railway). The PostgreSQL edition's own backup file is a PostgreSQL script and cannot be
loaded here, so a one-time command copies the data instead. Run it once, **before the first `npm start`** (it creates the database and
the tables itself, so the target is empty). If the system was already started, the first start has added the owner and the
transformation plan, and the command then needs `--replace` to empty the target first:

```bash
# PG_SOURCE_URL is the PostgreSQL connection string (it is only read); the target is the .env above.
PG_SOURCE_URL=postgres://user:password@host:port/db npm run migrate:from-postgres
```

(See `server/migrate-from-postgres.ts`. It refuses a target that already holds data unless `--replace` is given, copies
every table inside one transaction, and checks the row counts afterwards.)

## Backups

SQL Server is backed up the way the company already backs up its databases (full backup and transaction log backups of
`swish_pmo`). In addition the application has **Download a full backup** (PMO admin, backup page): one `.sql` file with
every table, run with `sqlcmd -S <server> -d <database> -b -i <file>` into a database where the application has started
once. Passwords and sign-in tokens are not in that file: after a restore every person is sent a new setup link.

## Local testing (for whoever changes the code)

The tests start the real server on a new, empty database for each run and drop it afterwards. They need a SQL login that
may create databases (`dbcreator`), given to the tests as environment variables:

```bash
TEST_MSSQL_HOST=localhost TEST_MSSQL_USER=<login> TEST_MSSQL_PASSWORD=<password> npm test
```

Each test database is created at compatibility level 150 (SQL Server 2019), so a statement that needs a newer server fails
the tests. `docs/TSQL-CONVERSION-GUIDE.md` lists how each PostgreSQL construct is written in this edition.

## Differences from the PostgreSQL edition

- `server/db.ts` (SQL Server driver) and `sql/schema.sql` replace the PostgreSQL driver and schema; every SQL text in
  `server/` is T-SQL.
- Foreign keys have no `ON DELETE` actions; `INSTEAD OF DELETE` triggers do the same cascades (deleting a project removes its
  plan, deleting a person leaves their work with no owner, and so on), because SQL Server cannot declare them on this model.
- Text comparison follows the database collation, which is usually case-insensitive (PostgreSQL's was case-sensitive).
- There is no embedded database: a SQL Server is always needed, including to develop.
