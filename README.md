# SWiSH PMO (SQL Server edition)

This is the SQL Server edition of SWiSH PMO: the same application as the PostgreSQL edition (same screens, rules and API), with
the data layer on Microsoft SQL Server 2019 or newer, for the company server. **IT: start with `docs/DEPLOY-IT.md`.** How each
PostgreSQL construct was written in T-SQL is in `docs/TSQL-CONVERSION-GUIDE.md`.

Portfolio and project management for the Project Management Office: the quarter's
projects on one route map, a full plan per project (Gantt with dependencies,
critical path and baseline), the weekly status cycle with a meeting mode, and an
executive report that prints to PDF. English and Arabic, light and dark.

This is **Phase 1**. Phase 2 (3-year roadmap and automated project selection by
criteria) and Phase 3 (enforced lifecycle gates: charter, scope, schedule, cost,
closure, post-closure) build on the same data model. Every project already
carries a lifecycle `stage`.

## Run locally

You need Node 22 and a SQL Server (an empty database and a login that owns it, see `docs/DEPLOY-IT.md`).

```bash
npm install
cp .env.example .env   # fill in the MSSQL_* settings and OWNER_EMAIL
npm run dev:server     # API on :8090
npm run dev            # UI on :5180
```

The server creates the tables on its first start (`sql/schema.sql`). With `OWNER_EMAIL=you@swishhh.net` in `.env` (git-ignored)
it prints the owner's setup link (`/#/activate/...`): open it on the UI's address to choose your password.

## Tests

```bash
TEST_MSSQL_USER=<login that may create databases> TEST_MSSQL_PASSWORD=<password> npm test
```

Unit tests for the working calendar, the scheduling engine and the tracker flags, and an end-to-end run of the real server on a
new, empty SQL Server database made for the run and dropped afterwards (no company data, no `.env`; at compatibility level 150,
so nothing newer than SQL Server 2019 can slip in): accounts, permissions, deadline changes and their approval, notifications,
escalations, holidays and the Excel export. `TEST_MSSQL_HOST` and `TEST_MSSQL_PORT` default to localhost and 1433.

## Import the tracker

The real projects come from the Execution Framework tracker. Export it
(`Export to Excel` on the tracker's dashboard), put the file under
`data/source/` (git-ignored: it is company data), and run:

```bash
npm run import -- data/source/execution-framework-all-2026-10-13.xlsx
```

Against the company database, run it where the `.env` points at it.

- Reads the `Projects` and `Milestones` sheets. Never writes to the tracker.
- Tracker categories become departments, phases become summary rows, each
  milestone becomes a milestone with its original deadline kept as the
  baseline, so slips show on the route map and the Gantt.
- Project % complete follows the tracker's rule: completed milestones over
  non-cancelled milestones.
- Blockers on open milestones become open issues. People are kept by name and
  linked to accounts automatically once the owner adds a user with that name.
- One transaction, then a check against counts taken from the spreadsheet; any
  mismatch fails the run. Add `--update` to replace projects that already
  exist (their app-side edits are lost). Details land in `data/import-report.json`.
## Accounts and permissions

The same model as the other SWiSH systems. No password lives in code or in an
environment variable.

- Only `@swishhh.net` emails can have accounts.
- Nobody can sign up. `OWNER_EMAIL` is the protected owner: always active,
  always PMO admin. The owner and the system admins the owner appoints are the
  only accounts that can create accounts, reset passwords and edit roles and
  permissions. No role can be given that power, not even PMO admin.
- The owner adds people from **Users & permissions** with an email and a role,
  never a password. Saving shows a **one-time setup link** (valid 7 days) to
  send them on Teams or WhatsApp; opening it, they choose a password and type
  it twice. Knowing someone's email is not enough to claim an account: the
  sign-in form refuses accounts that are not set up. Only a SHA-256 of the
  link's token is stored. A lost or expired link: **New setup link** on the
  person's card (the old link stops working).
- **Reset password** clears it, signs the person out and gives a new setup link.
- Passwords are at least 10 characters (`MIN_PASSWORD` in `shared/permissions.ts`,
  the old tracker's rule). The sign-in form answers "Email or password is not
  correct" for an unknown email and a wrong password alike, takes the same time
  for both, and locks after 8 failures per account or 30 per address for 15 minutes.
- The owner has nobody above them to send a link: while the owner account is
  not set up, each boot prints a fresh setup link to the server log. Set
  `APP_URL` for a full address. If every admin is locked out, `npm run invite-link -- someone@swishhh.net`
  (run on the server, where `.env` points at the database) resets that account and
  prints a link.
- Inside a project the chain is: **company owner -> department head -> project owner
  -> employee** (see "Roles and hierarchy" below). The project owner (or the head
  of its department, or the PMO) plans: adds, removes, orders and links tasks, gives
  them out, and decides about the project itself (owner, team, stage, budget,
  quarter, department, priority, dates). Everyone else reports on the tasks given to
  them and sees only those. **Re-baseline** (replacing every original date) is the
  PMO's alone and needs a reason, kept in the activity log.
- Roles are editable rows with switches for ten permissions (see
  `shared/permissions.ts`). Changes apply on the next request. The PMO admin
  role is locked to every permission.

## Milestone updates

Each task or milestone keeps an update log (`milestone_updates`), the way the
old tracker did. The task panel has one **Post an update** form (status, %,
what happened, blocker); the server writes one history row per report, with
author and time, and `tasks.update_comment` stays the latest word for the
portfolio and the report. Renames and date moves are plan changes, not
reports, and leave no row. On boot, every imported tracker comment becomes
the first row of its history (once, with no author). Deleting a task removes
its history; `--update` re-imports do too.

## Deadline changes and escalations

**Moving a milestone's deadline needs a reason** (a dialog asks, on the Gantt drag and on the date field).
The move applies at once so the plan stays live, and is kept in `deadline_changes` with who, when, from,
to and why. A move by the project manager or the PMO is approved when made; a team member's waits
(*Waiting for approval*) until the manager or the PMO approves it, or rejects it and the date goes back
(refused if it has moved again since). A person never decides on their own request. The **original
deadline** (`baseline_end`) is written the first time a milestone moves and never again; only the PMO's
re-baseline replaces it. A milestone pushed along by its predecessor gets an automatic, approved row.
Plain tasks and phases move without a reason: only milestones are commitments.

**Escalations** (`escalations`) are raised from the task panel: to whom, a note, and a level that is one
above the highest still open (1, 2, 3...). They are closed when resolved. Anyone who can edit the project
raises and closes them; whoever can see the project reads them.

The Dashboard counts **late or missing escalations** with the tracker's rule: a milestone past its deadline
that nobody escalated, or first escalated after the deadline (before or on the day is fine). The old
tracker's export carries no escalation history, so at the import every overdue milestone counts as never
escalated; the figure falls as escalations are logged. A second tile counts the **date changes waiting for
approval**. Both open the Milestones page on that filter.

## Notifications

The bell at the foot of the sidebar shows how many are unread; the list opens beside the page, and a
click marks one read and goes to the milestone (or to My work / Weekly review for reminders). Stored in
`notifications`, one row per person; nobody reads or marks another person's, and nobody is told about
their own action.

| What happens | Who is told |
| --- | --- |
| A team member moves a milestone's deadline | the project manager, or every PMO account if the project has none |
| That request is approved or rejected | the person who asked |
| An escalation is raised | the person it goes to (when the name matches an account) and the project manager |
| A milestone gets a new owner | the new owner |
| Someone is added to a project team | that person |
| Daily, on first opening the system | the owner of overdue, due-within-2-days or stale milestones: one summary a day |
| Weekly | a project manager whose weekly update is not filed yet: once a week |

The reminders are made when the bell asks for the count (every minute while the system is open), so no
scheduled job is needed; a unique key per person and day (or week) keeps them to one. Work given to someone is also emailed (see below); there is no
email yet: that waits on IT for a Microsoft 365 sender.

## Phones, tablets and other devices

The same page adapts from a 360px phone to a wide desktop screen, in English and Arabic (right to left).

- **Phone (up to 860px)**: the sidebar becomes a slim header with the logo, search, the bell and a menu
  button; the menu opens as a full sheet with every page, language, theme, sign out and the account. It
  closes on choosing a page or on Esc, and the page behind it does not scroll.
- **Touch screens**: buttons, tabs, chips and links get 40px hit areas, and fields use 16px text so an
  iPhone does not zoom in when one is tapped. Panels open full width. On the plan, a swipe scrolls the
  Gantt and a tap opens the milestone (its panel has the date fields); dragging bars is for mouse and pen.
- **Notch and home bar**: the page runs edge to edge (`viewport-fit=cover`) and keeps clear of them.
- **Add to home screen** (iPhone and Android): web app manifest and icons in `client/public`, so it opens
  full screen like an app. It is the website, not a store app; a Capacitor build is the route to one.
- Older browsers: `100dvh` has a `100vh` fallback. Targets Safari 16+, Chrome and Edge 105+, Firefox 110+.

## Search

The box under the logo, or **Ctrl+K** (Cmd+K on a Mac) from any page. It finds projects (name, Arabic
name, code) and milestones (name, code, owner) among the projects you can see, and lists the pages to
jump to. Arrow keys move, Enter opens: a project opens its page, a milestone opens its plan with the
milestone's panel. Arabic letter forms are folded on both sides (أ إ آ -> ا, ة -> ه, ى -> ي), so a name is
found however it was typed. Two letters are the minimum; at most 6 projects and 10 milestones come
back. Endpoint: `GET /api/search?q=`, same visibility as the portfolio.

## Working calendar

Friday and Saturday are off; the official holidays are kept under **Users & permissions -> Calendar**
(owner and system admins), one entry per holiday, several days for Eid. Like MS Project's calendar:

- The plan's **Days** column counts working days.
- A task pushed along by its predecessor starts on the first working day after it (a lag counts
  working days) and keeps its length in working days, stretching over the days off.
- A date on a Friday, a Saturday or a holiday is flagged under the date in the task panel, and holidays
  are tinted in the Gantt (named on hover in the header).

Adding or removing a holiday does not move plans already scheduled. The tracker's discipline flags
(overdue, needs an update after 7 days, the 4-day warning) stay in calendar days, as the tracker counts
them; switching them to working days is the PMO's decision.

## Co-owners, departments and the activity log

- **Co-owners**: every name on a milestone's co-owners list that matches an account is linked
  (`task_coowners`, filled by the same name matching as owners). Those milestones show in the person's
  **My work** with a *Co-owner* badge, and the person joins the project team, as owners do (so they can
  update the plan, like any team member). Editing the co-owners list re-links that milestone at once.
- **Departments** (Users & permissions -> Departments, owner and system admins): English and Arabic
  names and the department head, editable; the code and colour never change, so nothing that points at
  a department moves. New departments take a code once.
- **Activity log** (Users & permissions -> Activity log, owner and system admins): every create, change
  and decision the system records, newest first, 50 a page, filtered by kind, person and date range
  (Kuwait days). Department changes and health/stage changes show before -> after.

## Speed

What made the system feel heavy, measured on a slow line (1.6 Mbps, 150 ms, CPU x4):
responses were not compressed (the 720 KB script travelled as 720 KB), every page
reloaded all its data on each visit, and everything shipped in one script. Now: responses are
gzip-compressed (`compression`), the plan editor and the admin pages load the first time they are
opened, pages already visited show at once from memory and refresh behind the scenes (`useLoad`
with a key; cleared on sign-out), the Gantt redraws only its month labels on horizontal scroll, and
the Milestones page starts with 60 rows. Cold load 6.7 s to 3.1 s, first Milestones visit
3.6 s to 1.6 s. The grain and gradient background layers were tested and are not a cost.

## Dashboard and automatic flags

The **Dashboard** (second item in the menu) is the weekly review in numbers: overdue,
due in 7 days, **needs update**, **early warnings**, active projects by health, milestones
due over the next four weeks, a "needs attention" list (worst first) and a project review
table. Each tile opens the Milestones page on the same filter, with the same count.
The flags come from the milestone itself, in one place (`shared/health.ts`), so the
Dashboard, the Milestones page and the Excel export agree:

- **Overdue**: open and past its deadline.
- **Needs update**: open and no report for more than 7 days (never reported counts).
- **Early warning**: not late yet, and blocked or with a blocker logged.
- **At risk (auto)**: not late yet, due within 4 days and not started.

The 7 and 4 are the old tracker's defaults; they are the PMO's to confirm and change
(`STALE_DAYS`, `WARNING_DAYS`). On the 13 Oct import it gives 157 needs-update, the same
figure as the tracker. Late or missing escalations need escalation records, which are not built yet.

## Excel export

Export to Excel on the Portfolio (the quarter on screen, or **All projects**), on the
Milestones page (exactly the filtered rows) and on each project (its row, milestones,
the whole plan, update log, risks and weekly updates). Each person exports only what
they can see on screen. The Projects and Milestones sheets use the old tracker's column
names and words, so pivots built on the tracker keep working. `% Complete` follows the
tracker rule; the app's duration-weighted figure is in `Plan % Complete`. Times are
Kuwait time.

It is a report, not a backup. An exported workbook imports back through
`npm run import` for projects shaped like the tracker's (milestones only: tasks, risks,
weekly updates and the update log are not rebuilt, and `--update` replaces the project).
Use the Backup tab for a full copy.

## Backups

Two layers:

1. **SQL Server backups** of the `swish_pmo` database, as IT does for the company's other databases.
2. **The in-app file**: **Users & permissions -> Backup** (owner and system admins) downloads the whole database as one
   `.sql` file to keep outside the server. The page warns when the last download is over 7 days old. Passwords, sessions and
   setup links are left out. To restore, start the app once on the target database (so the tables exist), then:
   `sqlcmd -S <server> -d <database> -U <login> -b -i swish-pmo-backup-<date>.sql`.
   It replaces every row in one transaction. Every account then needs a new setup link (the owner's is in the start-up log).

## Deploy (company server)

See `docs/DEPLOY-IT.md`: the database and login, `npm ci`, `npm run build`, the `.env` settings, `npm start`, and how to move the
data of the PostgreSQL edition across once (`npm run migrate:from-postgres`).

- `/api/health` answers 200 only when the database answers.
- Every response carries a Content-Security-Policy (own scripts only, no inline
  scripts: the pre-paint theme script lives in `client/public/boot.js`), nosniff,
  no framing, same-origin referrer and HSTS.

## Layout

| Path | What lives there |
| --- | --- |
| `shared/schedule.ts` | Roll-ups, weighted progress, critical path, successor push. Used by server and browser. |
| `shared/dates.ts` | Calendar-day maths on `YYYY-MM-DD` strings. The work week starts Sunday (Kuwait). |
| `server/routes/` | `auth`, `meta` (people, my work), `projects` (plan, updates, risks). |
| `client/components/RouteMap.tsx` | The portfolio route map. |
| `client/components/Gantt.tsx` | The plan editor. |
| `client/pages/` | Portfolio, project, weekly review and meeting, report, my work, people. |

## Default roles

Created on first boot and editable afterwards (except PMO admin).

| Role | Starts with |
| --- | --- |
| PMO admin | Every permission. Locked. The only role that approves closing a project. |
| Company owner | See every project, report and meetings (read only), and start a project in any department, which hands it to that department's head. |
| Department head | Start projects in the departments they head, edit their projects, file weekly updates, see the report. |
| Executive | See every project, run the review meeting, see the report. |
| Project manager | The earlier role, kept: see every project, edit their own, file weekly updates, see the report. It can no longer start projects. |
| Team member | Edit the projects they belong to (their own tasks, unless they own the project). |

## Roles and hierarchy

Who does what is decided by a role (what a person can do anywhere) together with their place in each project
(owner, team member) and in each department (head). So the same employee is the owner of one project and an
ordinary team member in another.

| Level | How they are set | What they do |
| --- | --- | --- |
| **Company owner** | The role *Company owner* | Sees everything. Cannot change anything. Starts a project in any department, which gives it to that department's head. |
| **Department head** | The role *Department head*, plus the account chosen under Users & permissions -> Departments | Only a department head starts projects, and only in the departments they head. Sees every project of the department and runs it like its owner. Picks the project owner (any employee; themselves if they do not name one). |
| **Project owner** | The person named as the project's owner (any employee) | Plans (tasks, order, links), gives tasks out, edits the project, files the weekly update, asks to close it. |
| **Employee** | A member of the project, and a task given to them | Sees and updates only the tasks given to them (progress, status, blocker, comment; a milestone date change waits for approval as before). Cannot add, remove, link or give out tasks. |

Visibility follows the same lines: an employee's Milestones page, search, route map, My work and the project's plan
show only their own tasks (with the phases above them). The owner, the department head, the PMO and the people
who see everything see whole plans.

**On existing data**: on the first boot after this change the old *Project manager* role loses "create projects"
(once; later edits to roles are left alone), and a department head typed in the old tracker is linked to the
account of the same name when exactly one account has it. Check the Departments tab and link the rest.

## First sign-in by email

The PMO creates the person (company email and role) and that is all. The person opens the sign-in page, types
their company email and chooses **First time here? Email me my password**: a temporary password is emailed to that
mailbox, which only its owner can read. They sign in with it and are made to **choose their own password** before
anything else opens (the server refuses every other request until they have). No link has to be sent by hand.

- The temporary password is random (12 characters in three groups), works for **24 hours** and only until they
  choose their own; the emailed one stops working at once. A new one can be asked for every **10 minutes**, 20 asks
  per hour per address. A request for an email that has no account waiting, or one that already has its own
  password, gets the **same answer** and sends nothing: nobody can learn who has an account, and nobody can lock
  a colleague out by asking.
- If the mail cannot be sent, the account is put back as it was and the person is told to try again or ask the
  PMO, whose setup link still works. The link stays as the **backup** for the owner and the admins (the owner's
  own first sign-in is by the link printed in the boot log); an admin can replace an emailed password with a link.
- **Reset password** (owner and admins) clears the password; the person asks for a new one the same way.
- **Test email** (Users & permissions, owner and admins; shown when mail is set up) sends a test message to the admin's own
  address and shows what the mail server answered. `535 5.7.3 Authentication unsuccessful` is a wrong user name or
  password (an updated mailbox password not yet changed in `SMTP_PASS`); `5.7.139` means Microsoft has switched off
  SMTP AUTH for that mailbox or tenant (IT enables *Authenticated SMTP* for the mailbox). The same text is in the
  server log as `[mail] could not send ...`.
- **Delete a person** (the bin icon on their card, owner and admins): removes the account for good after a dialog
  that says what it touches. Never the owner, never yourself, and a system admin only by the owner. Someone who
  **owns a project or heads a department cannot be deleted** until those have someone else (the dialog lists them);
  deactivating keeps everything and is the way to let someone go for now. Their sessions, notifications and team
  places go with them, their open tasks become unassigned (the name written on the task stays), and what they did
  stays in the history without their name. The deletion is in the activity log.
- It needs a mailbox: `SMTP_HOST`, `SMTP_PORT` (587, STARTTLS), `SMTP_USER`, `SMTP_PASS` and optionally
  `MAIL_FROM` in the server's `.env` (never committed). Without them the button is not shown and everything
  works as before. `MAIL_CC` is deliberately **not** read for these emails. Tests use a stand-in mail server.

## The project assistant

On the Portfolio page, a department head (or the company owner, or the PMO) can choose **Create with the assistant**
and describe a project in a chat: "a new project called X in Supply Chain, from 1 November to the end of January,
milestones: design, pilot, go live". The assistant (Claude, through the Anthropic API) fills in a **draft** beside the
chat: name, department, owner, priority, dates, phases, milestones. It aims at a **complete** project (name, department, owner, dates,
objective, sponsor, priority, phases, milestones): it fills in only what it was told and **asks** for the rest, a few questions at a
time, listed under its reply, and a "Still needed" line above the draft checks the same list. It proposes dates or milestones only
when asked to ("suggest", "you decide"), and says so in a yellow note. Follow-ups apply on top of the draft ("add a
Testing milestone before go live"). Create stays available once the name, department and dates are there. Every field is editable by hand, and the hand edits travel with the next message.

The assistant **writes in English only** (reply, project name, milestones, notes), whatever the person types: Arabic input is understood and translated, and an Arabic project name the person gives is kept in the Arabic-name field. It runs on the fastest model (`claude-haiku-5-5`) with thinking off, low effort and a small output ceiling, because filling a form needs little reasoning and the waiting is the model writing; the chat shows the seconds waited, and every answer logs `[ai] <ms> model= in= out=` in the server log so the wait can be judged by numbers. If a request carries a setting the model rejects, the server asks again with the plain request. For more polish on unusual descriptions, `AI_MODEL=claude-sonnet-5-5` (or `claude-opus-5-5`) in `.env`, at the cost of speed.

**It only drafts.** Nothing exists until the person presses *Create the project*, which goes through the same creation
as the manual form, with the same rules: only a department head starts a project in their own department, the owner
defaults to the head, and so on. The chat endpoint (`POST /api/ai/project-draft`) offers the model only the departments
that person may start a project in and the people by name (no emails), forces a fixed JSON answer
(structured output), and cleans whatever comes back before the page sees it: unknown departments and people are
dropped, dates are checked and kept inside the project window, and milestones are moved to working days (Friday,
Saturday and the holidays under Calendar are skipped). Twenty requests per person in any ten minutes; a refused
or cut-off answer shows a plain message and the form stays available.

**Switching it on**: set `ANTHROPIC_API_KEY` in `.env`. Without it the button is not shown and nothing else changes.
`AI_MODEL` overrides the model (default `claude-haiku-5-5`). **What leaves the system**: only what the person types in
the chat, the names of the allowed departments, the active people's names, today's date and the current draft.
No projects, tasks or accounts are sent. Tests use a local stand-in for the API (no key, no network).

## Closing a project

Nobody marks a project finished alone. The project owner (or the department head, or the PMO) opens the project
and chooses **Request closure** with a note on what was delivered. The request waits, shown on the project and,
to people who approve, on top of the Dashboard. A **PMO admin** (anyone whose role holds *Approve project
closure*, which only PMO admin has by default) approves or rejects, with an optional reason:

- **Approve**: the project becomes stage *Closed*, health *Done*. The owner is told.
- **Reject**: the project carries on, and the owner sees the reason on the project and can ask again.

The stage *Closed* and the health *Done* cannot be set any other way (project details, weekly update) except by
someone who can approve, who may close directly. Nobody decides on their own request. Every step is in the
activity log (*closure.requested / approved / rejected*) and notifies the other side. A project nobody asked to
close stays open however complete its milestones are.

**The Delivery Document.** A request to close a project must carry it: a link to the document (SharePoint, OneDrive...) or the file itself
(PDF, Word, Excel, PowerPoint, image, text or zip, up to 8 MB, kept in the database and always served as a download), or both. Without one the request is
refused. The approver sees the link and the file on the Dashboard queue and on the project, and they stay on the project after it is closed.
A PMO admin who closes a project directly (no request) is not asked for one.

## Weekly update draft

In the **Write update** dialog, the project manager (or the head, or the PMO) can press **Draft from this week**. The
server collects what was reported on the project's milestones and tasks in the last 7 days (status, %, comment,
blocker), what is overdue or blocked, and what is due in the next 14 days, and the assistant writes the first draft of
the update: accomplishments, next steps, blockers and a suggested health. It only fills the boxes: the manager reads,
edits and saves, and nothing is filed until then. The draft is in English. Same switch as the project assistant
(`ANTHROPIC_API_KEY`; without it the button is not shown).

**What leaves the system** for one draft: the project's name, the names, dates, statuses, comments and blockers of its
tasks. No people, no emails and no other project. Same allowance as the assistant (20 requests per person per 10 minutes).
`POST /api/ai/weekly-draft/:id`, allowed to whoever may file the update.

## Ask about the projects

On the Portfolio page, **Ask about the projects** opens a chat for questions like "which Customer Care projects are late,
and why?" or "what is blocked this week?". The server builds a snapshot of **the projects this person can see**
(and, inside them, the tasks they can see: the same rules as the lists) and the assistant answers from it. It has no tools and
writes nothing: it can only read. It answers in the language of the question, mentions project codes, says when a reason is
not recorded instead of guessing one, and the codes under the answer open the projects. `POST /api/ai/ask`, any signed-in person.

**What leaves the system** for one question: for each visible project its name, code, department, owner's name, stage, health,
progress and dates, and its last weekly update (blockers, accomplishments, shortened); for the late or blocked tasks their names,
owners' names, blockers, latest comments and the reason of their last deadline move. At most 150 projects and 220 tasks.
Same allowance as the other assistants. The answer is only as good as what people recorded: check important figures in the project.

## Import a ready plan

**Create with the assistant** takes a pasted plan as well as a description: rows copied from an email, a Word or Excel table or
a list, in English or Arabic, up to 20000 characters. Each row becomes a milestone with its finish date (day-first dates in any
style; a date with no year is the next one; a Friday, a Saturday or a holiday moves to a working day), the project's name and window
come from the plan when the person gave none, and rows with no date are left empty and named in the notes, never invented. The result is
the same editable draft as before: nothing exists until the person presses Create.

## Emails about work given to you

When mail is set up, three notifications are also sent by email, in English and Arabic, with a button that opens the
project (or the task): **you are made the owner of a project** (at creation, or when the owner is changed), **a task is
given to you**, and **a project is started in the department you head**. The email is sent after the request has answered and never holds
it up: if it cannot be sent, the in-app notification is still there and the failure is logged (`[mail] could not send ...`). Nobody is
emailed about their own action. Each person can switch these emails off in the notifications panel (**Also email me when work is given
to me**; stored in `users.email_notifications`, on by default). The first-sign-in email is separate and always sent when asked.

## The fixed phases

Every new project is built with the same ten phases, in this order (`shared/phases.ts`): **Definition, Data Collection,
Analysis, Design, Build, Validation, Pilot, Rollout, Approval, Closeout**. Whoever starts the project (the form or the assistant)
ticks the ones it needs, all ticked at first. The ticked phases share the project's window one after the other; the rest still
appear in the plan, struck through and marked **Not required**, with no bar. Switch one on or off later from the phase's panel
(the owner, the department head or the PMO): a phase that has work in it cannot be marked Not required, and work cannot be put
under a phase that is. A phase with nothing in it is not work: it weighs nothing in the project's progress and is not on the critical
path. Projects that already exist are left as they are.


## More emails

Besides work given to you, two things that wait for you are also emailed (same switch in the notifications panel): **a deadline change to decide**
(to the project manager, with the task and the reason) and **a project closure to approve** (to the approvers, with the delivery document). And once a week, on
**Sunday at 10:00 Kuwait time**, each project manager who still owes the weekly update for the week gets a reminder with the project codes (change the day with
`WEEKLY_REMINDER_DAY`, 0 = Sunday, and the hour with `WEEKLY_REMINDER_HOUR`; `NO_REMINDER_JOB=1` switches the job off). A row in `email_sent` per person and week keeps it to once, across restarts.
When the assistant is switched on, the reminder also carries an **AI briefing**: two or three sentences on the
manager's open projects and up to three actions for the week, from what is overdue, blocked or due in the next 14
days. Only project and task names, dates and statuses go to the model, never people or emails. If the model fails,
the plain reminder goes out instead. `AI_DIGEST=0` switches the briefing off. At the same time, the system users listed in `PMO_BRIEFING_TO`
(comma-separated emails) get the briefing on every active project, once a week.

**Daily follow-up agent.** Every working morning (Sunday to Thursday, from `FOLLOWUP_HOUR`, 9:00 Kuwait) it emails each
milestone owner (or the project manager when the owner has no account) about their milestones that are overdue, blocked,
due within 4 days and not started, or without an update for 7+ days and due within 14. The same milestone is asked about
again after `FOLLOWUP_EVERY_DAYS` (2). Replies go through the email assistant (propose, then change on agreement).
`FOLLOWUP_ENABLED=1` switches it on; `FOLLOWUP_TEST_TO=<email>` sends up to `FOLLOWUP_TEST_LIMIT` (3) of the day's
emails to that address only, marked with who they were for. A PMO admin can preview or run it: `POST /api/followups/run`.
When `ESCALATE_AFTER` (2) follow-ups on a milestone go unanswered (no update since), it escalates one level up the line:
the milestone's "escalate to" person, the project manager, the department head, then the PMO (`PMO_BRIEFING_TO`, else PMO
admins). Each escalation is recorded on the milestone (raised by the assistant) and the next level is emailed; the next
level needs another `ESCALATE_AFTER` unanswered follow-ups. Test mode records nothing and sends previews only.

**AI recommendations.** With the daily run, once a week per project (`RECOMMEND_EVERY_DAYS`, 7) and for active projects
with late, blocked or at-risk milestones, the model proposes up to 4 changes (a realistic new deadline, a milestone given
to someone with room, a higher priority, new project dates), each with its reason. The server keeps only what checks out
and emails the project manager (else the department head, else the PMO), at most `RECOMMEND_PER_DAY` (5) projects a day.
One reply approves all ("yes"), some ("1 and 3") or none ("no"); approved changes go through the API as that person.
In test mode one project a day goes to `FOLLOWUP_TEST_TO`, and approving it changes nothing. PMO: `POST /api/recommendations/run`.

**Replies by email.** With `INBOUND_ADDRESS` (the Postmark inbound address) and `INBOUND_SECRET` (16+ characters) set, every email
carries a Reply-To on that address with a tag signed for its recipient. Postmark posts replies to
`https://postmark:<INBOUND_SECRET>@<host>/api/inbound/postmark`; a reply whose tag matches its sender, from an active user, is
answered by email by the portfolio assistant, from the projects that person can see. Once per message, at most 30 a day per person.
A reply can also ask for a change: project dates, a task's progress/status/deadline/blocker/note, the weekly update, or a decision on
a pending deadline move, change request or closure. The server writes the proposal back in its own words; nothing changes until the
person replies YES to that email (within 24 hours, once). The change then goes through the app's own API as that person, so every
permission and rule applies and the activity log records it. Proposals are kept in `email_actions`.

## The shape of a plan

A plan has three levels: **phases** hold **milestones**, and a milestone holds the **tasks** that lead to it. A phase sits at
the top of the plan (or inside another phase); a milestone at the top or inside a phase; a task only inside a milestone. The
server refuses anything else (a task at the top, a task straight inside a phase, a milestone inside a milestone or a task, a
milestone with tasks turned into a task), and the plan's **Task** button adds the task inside the selected milestone (or next to
the selected task), while **Milestone** adds it inside the selected phase. A milestone keeps its own date and status; the tasks under it
count as work and widen what its phase spans. A new project puts each of its milestones inside a phase: the one it names (the
assistant picks one), else the one its date falls in. Plans that already exist are not rearranged.

## Change requests and the change log

The formal change process (Group Compliance, 21 Oct 2026). Any proposed change to a project's **scope, cost or schedule** is
written on a **change request** (the project's **Changes** tab, the fields of the Change Request template: requested by, date,
description, reasons, actions to implement it and their date), approved first by the **head of the project's department** and then by
the **PMO** (roles holding *Give the final approval of change requests*, `changes.approve`; PMO admin by default), and only then
applied. The request can carry the new values it proposes (start or end date, budget, scope, objective, a milestone's new date or its
cancellation, new milestones inside a phase); the PMO's approval makes **the system apply them**, and the new dates become the
approved baseline. Approvers can also reject (with the reason), put on hold and take off hold; the person who asked can withdraw it
while it waits. Nobody decides on their own request; a request asked by the head, or in a department with no head, goes straight to the PMO.
Each step is notified (and the ones waiting for a decision emailed) and kept in the activity log, and the Dashboard lists the
requests waiting for you.

**The lock.** Once a project has an **approved baseline**, its dates, budget, scope and objective, and its milestones (their
dates, adding, cancelling or removing one) change only through an approved change request: the server refuses a direct change
(409) and the screens disable those fields. The work inside a milestone (its tasks) still changes freely, unless moving it would
push a milestone. Before the baseline the plan changes freely, and change requests can still be recorded.

**The change log** is the list on the Changes tab and a **Change Log** sheet in the project's Excel export, with the columns of the
PMO's Change Log workbook (ID, date, requested by, description, reasons, status, progress / reason for rejection, actions / area of
impact, completion / launch date, notes, plus the approvals). The owner, head or PMO keep the follow-up columns up to date.

## Closing documents

A request to close a project must carry two documents: the **Project Closure Report** and the signed **Project Sign-Off
Checklist** (PDF or Word, up to 8 MB each, kept in the database). Their templates download from the closure dialog
(`GET /api/templates/closure-report`, `/api/templates/sign-off-checklist`; the files are in `server/templates`). The Delivery
Document (link and/or file) is optional. The approver sees all of them in the Dashboard queue and on the project, and they stay on the
project after it is closed.

## The Portfolio by the transformation plan

The Portfolio no longer picks a quarter. It reads like the PMO's **SWiSH Transformation Capabilities** workbook (sheet
Projects): **Capability → Dimension → plan project → the projects of the system that deliver it → the project**. The top shows the
7 capabilities as cards (how many of their plan projects have started, the progress and health of their projects); a capability shows
its dimensions; a dimension lists its plan projects, each with the projects linked under it; a plan project shows the workbook's
columns (type, status, priority, owner, outcome, completion criteria, KPI, baseline, target, dates, parent initiative, dependency) and its
projects. A trail at the top leads back. The figures and the route map / list below always cover the level on screen (the route map shows
two months back and four ahead).

- **The plan** lives in `capabilities`, `dimensions` and `initiatives`, seeded on first boot from `server/seeds/transformation-plan.json`
  (the V2 workbook: 7 capabilities, 58 dimensions, 172 plan projects). The PMO loads a new version of the workbook with **Update from
  the workbook**: new rows are added, existing ones (same capability, dimension and name) take the workbook's values, nothing is removed.
- **Links**: each project of the system belongs to one plan project (`projects.initiative_id`). The projects of the tracker are placed under
  their plan project **by the first boot** that finds them unlinked, from `server/seeds/plan-links.json` (by project code; `low` marks a guess).
  It runs once: the PMO changes any link, or removes it, from **Link projects to the plan** or a plan project's page, and those choices stay.
  Projects not in the list stay unlinked, are counted on top and can be shown, so none is lost.

## Updating from the Milestones Tracker

**Update from the tracker** on the Portfolio (PMO only) takes the Milestones Tracker workbook (.xlsx, sheet `in`, header row "Project ID"), shows what it
would change (nothing is written), and applies it in one transaction:

- **Projects already in the system:** for the milestones that changed, the **status** (Completed = done, On Track = in progress, Not Started =
  to do, On Hold = blocked, Cancelled), **% complete**, the **last update comment** and the **blocker**; one row in the milestone's history
  each. Milestones are matched by their ID (`DF2-1` is `DF2-01`); an ID repeated in the file (the tracker repeats one per brand) counts
  only for the row whose description is the system milestone's own. Dates, owners, names and the plan are never touched.
- **Projects the system does not have:** created (department from the milestones' responsible department, phases and milestones as the
  tracker import makes them, baseline = the deadlines, linked to the plan from `plan-links.json` when listed).
- **Existing projects with no milestone at all** get the file's milestones.
- Milestones of the file that the system lacks for a project that has milestones, and milestones of the system the file lacks, are listed, not touched.

**Dates.** Opened in Arabic Excel, the tracker's month names become "?" ("29-?????-26"). The file's "Days to Deadline" survives: a deadline is the day
the file was calculated (found from the rows that still have a real date) plus those days. A deadline with neither is the next day with that number
(flagged in the preview). Only new projects and empty projects need dates.
