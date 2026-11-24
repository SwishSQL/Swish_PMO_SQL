-- SWiSH PMO - SQL Server schema. Safe to run again and again: every table, column and index is created only when it
-- is missing, so the application runs this file at start (and a DBA may run it by hand instead, see docs/DEPLOY-IT.md).
-- Batches are separated by lines holding only GO, as in SSMS and sqlcmd.
--
-- Differences from the PostgreSQL edition, all deliberate:
--   * Foreign keys carry no ON DELETE action. SQL Server rejects most of them as "multiple cascade paths", and a table
--     that points at itself (tasks.parent_id) cannot cascade at all. The same behaviour (CASCADE or SET NULL) is done by
--     the INSTEAD OF DELETE triggers at the end of this file.
--   * JSON is kept as NVARCHAR(MAX) with an ISJSON check, timestamps as DATETIMEOFFSET(3), booleans as BIT.
--   * Text that is indexed or unique is NVARCHAR(450), the rest NVARCHAR(MAX).

SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID(N'dbo.departments', N'U') IS NULL
CREATE TABLE dbo.departments (
  id            INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_departments PRIMARY KEY,
  code          NVARCHAR(450) NOT NULL CONSTRAINT uq_departments_code UNIQUE,
  name          NVARCHAR(MAX) NOT NULL,
  name_ar       NVARCHAR(MAX) NOT NULL CONSTRAINT df_departments_name_ar DEFAULT N'',
  color_slot    INT NOT NULL CONSTRAINT df_departments_color_slot DEFAULT 1,
  head_name     NVARCHAR(MAX) NULL,
  head_user_id  INT NULL
);
GO

IF OBJECT_ID(N'dbo.roles', N'U') IS NULL
CREATE TABLE dbo.roles (
  id           NVARCHAR(450) NOT NULL CONSTRAINT pk_roles PRIMARY KEY,
  name         NVARCHAR(MAX) NOT NULL,
  name_ar      NVARCHAR(MAX) NOT NULL CONSTRAINT df_roles_name_ar DEFAULT N'',
  permissions  NVARCHAR(MAX) NOT NULL CONSTRAINT df_roles_permissions DEFAULT N'[]' CONSTRAINT ck_roles_permissions CHECK (ISJSON(permissions) = 1),
  protected    BIT NOT NULL CONSTRAINT df_roles_protected DEFAULT 0,
  created_at   DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_roles_created_at DEFAULT SYSDATETIMEOFFSET()
);
GO

-- No password is ever set by an admin or stored in code. An account is created by email with must_set_password, and
-- the first sign-in stores the password the person types. A reset puts the account back in that state.
IF OBJECT_ID(N'dbo.users', N'U') IS NULL
CREATE TABLE dbo.users (
  id                        INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_users PRIMARY KEY,
  email                     NVARCHAR(450) NOT NULL CONSTRAINT uq_users_email UNIQUE,
  name                      NVARCHAR(MAX) NOT NULL,
  password_hash             NVARCHAR(MAX) NULL,
  must_set_password         BIT NOT NULL CONSTRAINT df_users_must_set_password DEFAULT 1,
  role_id                   NVARCHAR(450) NOT NULL CONSTRAINT df_users_role_id DEFAULT N'member' CONSTRAINT fk_users_role FOREIGN KEY REFERENCES dbo.roles(id),
  title                     NVARCHAR(MAX) NULL,
  department_id             INT NULL CONSTRAINT fk_users_department FOREIGN KEY REFERENCES dbo.departments(id),
  active                    BIT NOT NULL CONSTRAINT df_users_active DEFAULT 1,
  last_login_at             DATETIMEOFFSET(3) NULL,
  created_by                INT NULL,
  created_at                DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_users_created_at DEFAULT SYSDATETIMEOFFSET(),
  -- A system admin manages accounts and permissions like the owner does. Only the owner grants or removes it.
  is_system_admin           BIT NOT NULL CONSTRAINT df_users_is_system_admin DEFAULT 0,
  -- One-time setup link for a new or reset account. Only the SHA-256 of the token is kept.
  invite_token_hash         NVARCHAR(450) NULL,
  invite_expires_at         DATETIMEOFFSET(3) NULL,
  -- Who made the current setup link, and when and through whose link the password was last set.
  invite_issued_by          INT NULL CONSTRAINT fk_users_invite_issued_by FOREIGN KEY REFERENCES dbo.users(id),
  password_set_at           DATETIMEOFFSET(3) NULL,
  password_link_by          INT NULL CONSTRAINT fk_users_password_link_by FOREIGN KEY REFERENCES dbo.users(id),
  -- First sign-in by email: a temporary password is emailed when the person asks for it on the sign-in page.
  -- temp_password stays true until they choose their own, and the API allows nothing else until then.
  temp_password             BIT NOT NULL CONSTRAINT df_users_temp_password DEFAULT 0,
  temp_password_expires_at  DATETIMEOFFSET(3) NULL,
  temp_password_sent_at     DATETIMEOFFSET(3) NULL,
  -- Whether the person is also emailed about work given to them (a project, a task). Their own switch.
  email_notifications       BIT NOT NULL CONSTRAINT df_users_email_notifications DEFAULT 1
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'fk_departments_head_user')
ALTER TABLE dbo.departments ADD CONSTRAINT fk_departments_head_user FOREIGN KEY (head_user_id) REFERENCES dbo.users(id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'users_invite_idx' AND object_id = OBJECT_ID(N'dbo.users'))
CREATE UNIQUE INDEX users_invite_idx ON dbo.users(invite_token_hash) WHERE invite_token_hash IS NOT NULL;
GO

IF OBJECT_ID(N'dbo.sessions', N'U') IS NULL
CREATE TABLE dbo.sessions (
  token       NVARCHAR(450) NOT NULL CONSTRAINT pk_sessions PRIMARY KEY,
  user_id     INT NOT NULL CONSTRAINT fk_sessions_user FOREIGN KEY REFERENCES dbo.users(id),
  expires_at  DATETIMEOFFSET(3) NOT NULL
);
GO

IF OBJECT_ID(N'dbo.quarters', N'U') IS NULL
CREATE TABLE dbo.quarters (
  id         INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_quarters PRIMARY KEY,
  code       NVARCHAR(450) NOT NULL CONSTRAINT uq_quarters_code UNIQUE,
  year       INT NOT NULL,
  q          INT NOT NULL CONSTRAINT ck_quarters_q CHECK (q BETWEEN 1 AND 4),
  starts_on  DATE NOT NULL,
  ends_on    DATE NOT NULL
);
GO

-- The transformation plan (the PMO's Transformation Capabilities workbook): capabilities, their dimensions, and the
-- plan's projects in each dimension. Projects of the system are linked to a plan project.
IF OBJECT_ID(N'dbo.capabilities', N'U') IS NULL
CREATE TABLE dbo.capabilities (
  id    INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_capabilities PRIMARY KEY,
  name  NVARCHAR(450) NOT NULL CONSTRAINT uq_capabilities_name UNIQUE,
  sort  INT NOT NULL CONSTRAINT df_capabilities_sort DEFAULT 0
);
GO

IF OBJECT_ID(N'dbo.dimensions', N'U') IS NULL
CREATE TABLE dbo.dimensions (
  id             INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_dimensions PRIMARY KEY,
  capability_id  INT NOT NULL CONSTRAINT fk_dimensions_capability FOREIGN KEY REFERENCES dbo.capabilities(id),
  name           NVARCHAR(450) NOT NULL,
  sort           INT NOT NULL CONSTRAINT df_dimensions_sort DEFAULT 0,
  CONSTRAINT uq_dimensions_name UNIQUE (capability_id, name)
);
GO

IF OBJECT_ID(N'dbo.initiatives', N'U') IS NULL
CREATE TABLE dbo.initiatives (
  id                   INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_initiatives PRIMARY KEY,
  dimension_id         INT NOT NULL CONSTRAINT fk_initiatives_dimension FOREIGN KEY REFERENCES dbo.dimensions(id),
  name                 NVARCHAR(450) NOT NULL,
  type                 NVARCHAR(MAX) NULL,
  status               NVARCHAR(MAX) NULL,
  priority             NVARCHAR(MAX) NULL,
  owner                NVARCHAR(MAX) NULL,
  outcome              NVARCHAR(MAX) NULL,
  completion_criteria  NVARCHAR(MAX) NULL,
  outcome_kpi          NVARCHAR(MAX) NULL,
  baseline             NVARCHAR(MAX) NULL,
  target               NVARCHAR(MAX) NULL,
  start_date           NVARCHAR(MAX) NULL,
  target_completion    NVARCHAR(MAX) NULL,
  parent_initiative    NVARCHAR(MAX) NULL,
  dependency           NVARCHAR(MAX) NULL,
  sort                 INT NOT NULL CONSTRAINT df_initiatives_sort DEFAULT 0,
  CONSTRAINT uq_initiatives_name UNIQUE (dimension_id, name)
);
GO

IF OBJECT_ID(N'dbo.projects', N'U') IS NULL
CREATE TABLE dbo.projects (
  id              INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_projects PRIMARY KEY,
  code            NVARCHAR(450) NOT NULL CONSTRAINT uq_projects_code UNIQUE,
  name            NVARCHAR(MAX) NOT NULL,
  name_ar         NVARCHAR(MAX) NULL,
  description     NVARCHAR(MAX) NULL,
  objective       NVARCHAR(MAX) NULL,
  scope           NVARCHAR(MAX) NULL,
  department_id   INT NOT NULL CONSTRAINT fk_projects_department FOREIGN KEY REFERENCES dbo.departments(id),
  manager_id      INT NULL CONSTRAINT fk_projects_manager FOREIGN KEY REFERENCES dbo.users(id),
  sponsor         NVARCHAR(MAX) NULL,
  quarter_id      INT NULL CONSTRAINT fk_projects_quarter FOREIGN KEY REFERENCES dbo.quarters(id),
  priority        NVARCHAR(50) NOT NULL CONSTRAINT df_projects_priority DEFAULT N'medium' CONSTRAINT ck_projects_priority CHECK (priority IN (N'critical', N'high', N'medium', N'low')),
  stage           NVARCHAR(50) NOT NULL CONSTRAINT df_projects_stage DEFAULT N'initiation' CONSTRAINT ck_projects_stage CHECK (stage IN (N'initiation', N'planning', N'execution', N'closure', N'closed')),
  health          NVARCHAR(50) NOT NULL CONSTRAINT df_projects_health DEFAULT N'not_started' CONSTRAINT ck_projects_health CHECK (health IN (N'not_started', N'on_track', N'at_risk', N'off_track', N'done')),
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  baseline_start  DATE NULL,
  baseline_end    DATE NULL,
  progress        INT NOT NULL CONSTRAINT df_projects_progress DEFAULT 0,
  budget          DECIMAL(14,3) NULL,
  archived        BIT NOT NULL CONSTRAINT df_projects_archived DEFAULT 0,
  created_by      INT NULL CONSTRAINT fk_projects_created_by FOREIGN KEY REFERENCES dbo.users(id),
  created_at      DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_projects_created_at DEFAULT SYSDATETIMEOFFSET(),
  updated_at      DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_projects_updated_at DEFAULT SYSDATETIMEOFFSET(),
  owner_name      NVARCHAR(MAX) NULL,
  gate            NVARCHAR(MAX) NULL,
  success_metric  NVARCHAR(MAX) NULL,
  success_target  NVARCHAR(MAX) NULL,
  initiative_id   INT NULL CONSTRAINT fk_projects_initiative FOREIGN KEY REFERENCES dbo.initiatives(id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'projects_quarter_idx' AND object_id = OBJECT_ID(N'dbo.projects'))
CREATE INDEX projects_quarter_idx ON dbo.projects(quarter_id);
GO

IF OBJECT_ID(N'dbo.project_members', N'U') IS NULL
CREATE TABLE dbo.project_members (
  project_id  INT NOT NULL CONSTRAINT fk_project_members_project FOREIGN KEY REFERENCES dbo.projects(id),
  user_id     INT NOT NULL CONSTRAINT fk_project_members_user FOREIGN KEY REFERENCES dbo.users(id),
  role        NVARCHAR(MAX) NOT NULL CONSTRAINT df_project_members_role DEFAULT N'Member',
  CONSTRAINT pk_project_members PRIMARY KEY (project_id, user_id)
);
GO

IF OBJECT_ID(N'dbo.tasks', N'U') IS NULL
CREATE TABLE dbo.tasks (
  id                 INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_tasks PRIMARY KEY,
  project_id         INT NOT NULL CONSTRAINT fk_tasks_project FOREIGN KEY REFERENCES dbo.projects(id),
  parent_id          INT NULL CONSTRAINT fk_tasks_parent FOREIGN KEY REFERENCES dbo.tasks(id),
  kind               NVARCHAR(50) NOT NULL CONSTRAINT df_tasks_kind DEFAULT N'task' CONSTRAINT ck_tasks_kind CHECK (kind IN (N'summary', N'task', N'milestone')),
  name               NVARCHAR(MAX) NOT NULL,
  start_date         DATE NOT NULL,
  end_date           DATE NOT NULL,
  baseline_start     DATE NULL,
  baseline_end       DATE NULL,
  progress           INT NOT NULL CONSTRAINT df_tasks_progress DEFAULT 0 CONSTRAINT ck_tasks_progress CHECK (progress BETWEEN 0 AND 100),
  status             NVARCHAR(50) NOT NULL CONSTRAINT df_tasks_status DEFAULT N'todo' CONSTRAINT tasks_status_check CHECK (status IN (N'todo', N'in_progress', N'blocked', N'done', N'cancelled')),
  assignee_id        INT NULL CONSTRAINT fk_tasks_assignee FOREIGN KEY REFERENCES dbo.users(id),
  sort               INT NOT NULL CONSTRAINT df_tasks_sort DEFAULT 0,
  notes              NVARCHAR(MAX) NULL,
  -- Tracker fields. Names stay as text because most of the people in the tracker have no account here yet. An
  -- assignee or manager is linked as soon as a user with the same name exists.
  code               NVARCHAR(450) NULL,
  owner_name         NVARCHAR(MAX) NULL,
  co_owners          NVARCHAR(MAX) NULL,
  responsible_dept   NVARCHAR(MAX) NULL,
  escalate_to        NVARCHAR(MAX) NULL,
  blocker            NVARCHAR(MAX) NULL,
  -- A fixed phase the project does not need. It stays in the plan, marked Not required.
  not_required       BIT NOT NULL CONSTRAINT df_tasks_not_required DEFAULT 0,
  dependency_type    NVARCHAR(MAX) NULL,
  last_update_on     DATE NULL,
  update_comment     NVARCHAR(MAX) NULL,
  stream             NVARCHAR(MAX) NULL,
  -- When the comment itself was written. last_update_on also moves on status, % and blocker changes.
  update_comment_on  DATE NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'tasks_project_idx' AND object_id = OBJECT_ID(N'dbo.tasks'))
CREATE INDEX tasks_project_idx ON dbo.tasks(project_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'tasks_code_idx' AND object_id = OBJECT_ID(N'dbo.tasks'))
CREATE UNIQUE INDEX tasks_code_idx ON dbo.tasks(project_id, code) WHERE code IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'tasks_assignee_idx' AND object_id = OBJECT_ID(N'dbo.tasks'))
CREATE INDEX tasks_assignee_idx ON dbo.tasks(assignee_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'tasks_parent_idx' AND object_id = OBJECT_ID(N'dbo.tasks'))
CREATE INDEX tasks_parent_idx ON dbo.tasks(parent_id);
GO

IF OBJECT_ID(N'dbo.task_dependencies', N'U') IS NULL
CREATE TABLE dbo.task_dependencies (
  id              INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_task_dependencies PRIMARY KEY,
  project_id      INT NOT NULL CONSTRAINT fk_task_dependencies_project FOREIGN KEY REFERENCES dbo.projects(id),
  predecessor_id  INT NOT NULL CONSTRAINT fk_task_dependencies_pred FOREIGN KEY REFERENCES dbo.tasks(id),
  successor_id    INT NOT NULL CONSTRAINT fk_task_dependencies_succ FOREIGN KEY REFERENCES dbo.tasks(id),
  lag_days        INT NOT NULL CONSTRAINT df_task_dependencies_lag DEFAULT 0,
  CONSTRAINT uq_task_dependencies UNIQUE (predecessor_id, successor_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'task_dependencies_succ_idx' AND object_id = OBJECT_ID(N'dbo.task_dependencies'))
CREATE INDEX task_dependencies_succ_idx ON dbo.task_dependencies(successor_id);
GO

IF OBJECT_ID(N'dbo.status_updates', N'U') IS NULL
CREATE TABLE dbo.status_updates (
  id               INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_status_updates PRIMARY KEY,
  project_id       INT NOT NULL CONSTRAINT fk_status_updates_project FOREIGN KEY REFERENCES dbo.projects(id),
  week_start       DATE NOT NULL,
  health           NVARCHAR(50) NOT NULL CONSTRAINT ck_status_updates_health CHECK (health IN (N'not_started', N'on_track', N'at_risk', N'off_track', N'done')),
  progress         INT NOT NULL CONSTRAINT df_status_updates_progress DEFAULT 0,
  accomplishments  NVARCHAR(MAX) NOT NULL CONSTRAINT df_status_updates_acc DEFAULT N'',
  next_steps       NVARCHAR(MAX) NOT NULL CONSTRAINT df_status_updates_next DEFAULT N'',
  blockers         NVARCHAR(MAX) NOT NULL CONSTRAINT df_status_updates_blockers DEFAULT N'',
  decisions        NVARCHAR(MAX) NOT NULL CONSTRAINT df_status_updates_decisions DEFAULT N'',
  author_id        INT NULL CONSTRAINT fk_status_updates_author FOREIGN KEY REFERENCES dbo.users(id),
  submitted_at     DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_status_updates_submitted DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT uq_status_updates UNIQUE (project_id, week_start)
);
GO

IF OBJECT_ID(N'dbo.meeting_notes', N'U') IS NULL
CREATE TABLE dbo.meeting_notes (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_meeting_notes PRIMARY KEY,
  update_id   INT NOT NULL CONSTRAINT fk_meeting_notes_update FOREIGN KEY REFERENCES dbo.status_updates(id),
  kind        NVARCHAR(50) NOT NULL CONSTRAINT df_meeting_notes_kind DEFAULT N'comment' CONSTRAINT ck_meeting_notes_kind CHECK (kind IN (N'comment', N'decision', N'action')),
  body        NVARCHAR(MAX) NOT NULL,
  author_id   INT NULL CONSTRAINT fk_meeting_notes_author FOREIGN KEY REFERENCES dbo.users(id),
  created_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_meeting_notes_created DEFAULT SYSDATETIMEOFFSET()
);
GO

IF OBJECT_ID(N'dbo.risks', N'U') IS NULL
CREATE TABLE dbo.risks (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_risks PRIMARY KEY,
  project_id  INT NOT NULL CONSTRAINT fk_risks_project FOREIGN KEY REFERENCES dbo.projects(id),
  kind        NVARCHAR(50) NOT NULL CONSTRAINT df_risks_kind DEFAULT N'risk' CONSTRAINT ck_risks_kind CHECK (kind IN (N'risk', N'issue')),
  title       NVARCHAR(MAX) NOT NULL,
  impact      NVARCHAR(50) NOT NULL CONSTRAINT df_risks_impact DEFAULT N'medium' CONSTRAINT ck_risks_impact CHECK (impact IN (N'low', N'medium', N'high')),
  likelihood  NVARCHAR(50) NOT NULL CONSTRAINT df_risks_likelihood DEFAULT N'medium' CONSTRAINT ck_risks_likelihood CHECK (likelihood IN (N'low', N'medium', N'high')),
  status      NVARCHAR(50) NOT NULL CONSTRAINT df_risks_status DEFAULT N'open' CONSTRAINT ck_risks_status CHECK (status IN (N'open', N'mitigating', N'closed')),
  owner_id    INT NULL CONSTRAINT fk_risks_owner FOREIGN KEY REFERENCES dbo.users(id),
  mitigation  NVARCHAR(MAX) NULL,
  due_date    DATE NULL,
  created_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_risks_created DEFAULT SYSDATETIMEOFFSET()
);
GO

IF OBJECT_ID(N'dbo.activity', N'U') IS NULL
CREATE TABLE dbo.activity (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_activity PRIMARY KEY,
  project_id  INT NULL CONSTRAINT fk_activity_project FOREIGN KEY REFERENCES dbo.projects(id),
  user_id     INT NULL CONSTRAINT fk_activity_user FOREIGN KEY REFERENCES dbo.users(id),
  action      NVARCHAR(MAX) NOT NULL,
  detail      NVARCHAR(MAX) NOT NULL CONSTRAINT df_activity_detail DEFAULT N'{}' CONSTRAINT ck_activity_detail CHECK (ISJSON(detail) = 1),
  created_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_activity_created DEFAULT SYSDATETIMEOFFSET()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'activity_project_idx' AND object_id = OBJECT_ID(N'dbo.activity'))
CREATE INDEX activity_project_idx ON dbo.activity(project_id, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'activity_created_idx' AND object_id = OBJECT_ID(N'dbo.activity'))
CREATE INDEX activity_created_idx ON dbo.activity(created_at DESC);
GO

-- Every update posted on a task or milestone, as the old tracker kept it: the state after the report (status, %,
-- blocker) plus what was said. tasks.update_comment stays the latest word.
IF OBJECT_ID(N'dbo.milestone_updates', N'U') IS NULL
CREATE TABLE dbo.milestone_updates (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_milestone_updates PRIMARY KEY,
  task_id     INT NOT NULL CONSTRAINT fk_milestone_updates_task FOREIGN KEY REFERENCES dbo.tasks(id),
  author_id   INT NULL CONSTRAINT fk_milestone_updates_author FOREIGN KEY REFERENCES dbo.users(id),
  created_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_milestone_updates_created DEFAULT SYSDATETIMEOFFSET(),
  status      NVARCHAR(MAX) NOT NULL,
  progress    INT NOT NULL,
  comment     NVARCHAR(MAX) NULL,
  blocker     NVARCHAR(MAX) NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'milestone_updates_task_idx' AND object_id = OBJECT_ID(N'dbo.milestone_updates'))
CREATE INDEX milestone_updates_task_idx ON dbo.milestone_updates(task_id, created_at DESC);
GO

-- A move of a milestone's deadline, with its reason. The original deadline is tasks.baseline_end and is never touched
-- by a move. A team member's move waits for the project manager or the PMO (pending, then approved or rejected, which
-- puts the date back). Moves made by the manager or the PMO, and successors pushed along by a move, are approved at once.
IF OBJECT_ID(N'dbo.deadline_changes', N'U') IS NULL
CREATE TABLE dbo.deadline_changes (
  id            INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_deadline_changes PRIMARY KEY,
  task_id       INT NOT NULL CONSTRAINT fk_deadline_changes_task FOREIGN KEY REFERENCES dbo.tasks(id),
  from_date     DATE NOT NULL,
  to_date       DATE NOT NULL,
  reason        NVARCHAR(MAX) NOT NULL,
  requested_by  INT NULL CONSTRAINT fk_deadline_changes_requested FOREIGN KEY REFERENCES dbo.users(id),
  requested_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_deadline_changes_requested DEFAULT SYSDATETIMEOFFSET(),
  status        NVARCHAR(50) NOT NULL CONSTRAINT df_deadline_changes_status DEFAULT N'approved' CONSTRAINT ck_deadline_changes_status CHECK (status IN (N'pending', N'approved', N'rejected')),
  decided_by    INT NULL CONSTRAINT fk_deadline_changes_decided FOREIGN KEY REFERENCES dbo.users(id),
  decided_at    DATETIMEOFFSET(3) NULL,
  automatic     BIT NOT NULL CONSTRAINT df_deadline_changes_automatic DEFAULT 0
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'deadline_changes_task_idx' AND object_id = OBJECT_ID(N'dbo.deadline_changes'))
CREATE INDEX deadline_changes_task_idx ON dbo.deadline_changes(task_id, requested_at DESC);
GO

-- Escalations on a milestone: how far up it went (level), to whom, and whether it is still open.
IF OBJECT_ID(N'dbo.escalations', N'U') IS NULL
CREATE TABLE dbo.escalations (
  id           INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_escalations PRIMARY KEY,
  task_id      INT NOT NULL CONSTRAINT fk_escalations_task FOREIGN KEY REFERENCES dbo.tasks(id),
  level        INT NOT NULL CONSTRAINT df_escalations_level DEFAULT 1,
  raised_by    INT NULL CONSTRAINT fk_escalations_raised FOREIGN KEY REFERENCES dbo.users(id),
  to_name      NVARCHAR(MAX) NOT NULL,
  note         NVARCHAR(MAX) NULL,
  raised_at    DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_escalations_raised DEFAULT SYSDATETIMEOFFSET(),
  resolved_at  DATETIMEOFFSET(3) NULL,
  resolved_by  INT NULL CONSTRAINT fk_escalations_resolved FOREIGN KEY REFERENCES dbo.users(id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'escalations_task_idx' AND object_id = OBJECT_ID(N'dbo.escalations'))
CREATE INDEX escalations_task_idx ON dbo.escalations(task_id, raised_at);
GO

-- Who is named on a task's co-owners list and has an account. Filled by linkPeople, like the owner link.
IF OBJECT_ID(N'dbo.task_coowners', N'U') IS NULL
CREATE TABLE dbo.task_coowners (
  task_id  INT NOT NULL CONSTRAINT fk_task_coowners_task FOREIGN KEY REFERENCES dbo.tasks(id),
  user_id  INT NOT NULL CONSTRAINT fk_task_coowners_user FOREIGN KEY REFERENCES dbo.users(id),
  CONSTRAINT pk_task_coowners PRIMARY KEY (task_id, user_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'task_coowners_user_idx' AND object_id = OBJECT_ID(N'dbo.task_coowners'))
CREATE INDEX task_coowners_user_idx ON dbo.task_coowners(user_id);
GO

-- In-app notifications: for whom, what happened (kind + data), where it points, read or not.
IF OBJECT_ID(N'dbo.notifications', N'U') IS NULL
CREATE TABLE dbo.notifications (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_notifications PRIMARY KEY,
  user_id     INT NOT NULL CONSTRAINT fk_notifications_user FOREIGN KEY REFERENCES dbo.users(id),
  kind        NVARCHAR(MAX) NOT NULL,
  project_id  INT NULL CONSTRAINT fk_notifications_project FOREIGN KEY REFERENCES dbo.projects(id),
  task_id     INT NULL CONSTRAINT fk_notifications_task FOREIGN KEY REFERENCES dbo.tasks(id),
  data        NVARCHAR(MAX) NOT NULL CONSTRAINT df_notifications_data DEFAULT N'{}' CONSTRAINT ck_notifications_data CHECK (ISJSON(data) = 1),
  dedupe_key  NVARCHAR(450) NULL,
  created_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_notifications_created DEFAULT SYSDATETIMEOFFSET(),
  read_at     DATETIMEOFFSET(3) NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'notifications_user_idx' AND object_id = OBJECT_ID(N'dbo.notifications'))
CREATE INDEX notifications_user_idx ON dbo.notifications(user_id, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'notifications_dedupe_idx' AND object_id = OBJECT_ID(N'dbo.notifications'))
CREATE UNIQUE INDEX notifications_dedupe_idx ON dbo.notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
GO

-- One-time data changes that must not repeat on every start (the owner edits roles afterwards).
IF OBJECT_ID(N'dbo.schema_flags', N'U') IS NULL
CREATE TABLE dbo.schema_flags (
  name     NVARCHAR(450) NOT NULL CONSTRAINT pk_schema_flags PRIMARY KEY,
  done_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_schema_flags_done DEFAULT SYSDATETIMEOFFSET()
);
GO

-- Closing a project is asked for by its owner and decided by a PMO admin: nobody marks one finished alone.
IF OBJECT_ID(N'dbo.closure_requests', N'U') IS NULL
CREATE TABLE dbo.closure_requests (
  id                   INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_closure_requests PRIMARY KEY,
  project_id           INT NOT NULL CONSTRAINT fk_closure_requests_project FOREIGN KEY REFERENCES dbo.projects(id),
  requested_by         INT NULL CONSTRAINT fk_closure_requests_requested FOREIGN KEY REFERENCES dbo.users(id),
  note                 NVARCHAR(MAX) NOT NULL CONSTRAINT df_closure_requests_note DEFAULT N'',
  status               NVARCHAR(50) NOT NULL CONSTRAINT df_closure_requests_status DEFAULT N'pending' CONSTRAINT ck_closure_requests_status CHECK (status IN (N'pending', N'approved', N'rejected')),
  decided_by           INT NULL CONSTRAINT fk_closure_requests_decided FOREIGN KEY REFERENCES dbo.users(id),
  decided_at           DATETIMEOFFSET(3) NULL,
  decision_note        NVARCHAR(MAX) NULL,
  created_at           DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_closure_requests_created DEFAULT SYSDATETIMEOFFSET(),
  -- The Delivery Document that comes with a request to close: a link, a file kept here, or both.
  delivery_url         NVARCHAR(MAX) NULL,
  delivery_file_name   NVARCHAR(MAX) NULL,
  delivery_file_type   NVARCHAR(MAX) NULL,
  delivery_file        VARBINARY(MAX) NULL,
  -- The two documents a project cannot close without (the closure report and the signed sign-off checklist).
  report_file_name     NVARCHAR(MAX) NULL,
  report_file_type     NVARCHAR(MAX) NULL,
  report_file          VARBINARY(MAX) NULL,
  checklist_file_name  NVARCHAR(MAX) NULL,
  checklist_file_type  NVARCHAR(MAX) NULL,
  checklist_file       VARBINARY(MAX) NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'closure_one_pending_idx' AND object_id = OBJECT_ID(N'dbo.closure_requests'))
CREATE UNIQUE INDEX closure_one_pending_idx ON dbo.closure_requests(project_id) WHERE status = N'pending';
GO

-- A change request: a proposed change to the scope, cost or schedule of a project, its two approvals (the head of the
-- department, then the PMO) and what became of it. It is the project's change log too.
IF OBJECT_ID(N'dbo.change_requests', N'U') IS NULL
CREATE TABLE dbo.change_requests (
  id               INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_change_requests PRIMARY KEY,
  project_id       INT NOT NULL CONSTRAINT fk_change_requests_project FOREIGN KEY REFERENCES dbo.projects(id),
  seq              INT NOT NULL,
  requested_by     INT NULL CONSTRAINT fk_change_requests_requested FOREIGN KEY REFERENCES dbo.users(id),
  requested_at     DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_change_requests_requested DEFAULT SYSDATETIMEOFFSET(),
  areas            NVARCHAR(MAX) NOT NULL CONSTRAINT df_change_requests_areas DEFAULT N'[]' CONSTRAINT ck_change_requests_areas CHECK (ISJSON(areas) = 1),
  description      NVARCHAR(MAX) NOT NULL,
  reason           NVARCHAR(MAX) NOT NULL,
  actions          NVARCHAR(MAX) NOT NULL CONSTRAINT df_change_requests_actions DEFAULT N'',
  actions_date     DATE NULL,
  changes          NVARCHAR(MAX) NOT NULL CONSTRAINT df_change_requests_changes DEFAULT N'{}' CONSTRAINT ck_change_requests_changes CHECK (ISJSON(changes) = 1),
  snapshot         NVARCHAR(MAX) NOT NULL CONSTRAINT df_change_requests_snapshot DEFAULT N'{}' CONSTRAINT ck_change_requests_snapshot CHECK (ISJSON(snapshot) = 1),
  status           NVARCHAR(50) NOT NULL CONSTRAINT df_change_requests_status DEFAULT N'pending' CONSTRAINT ck_change_requests_status CHECK (status IN (N'pending', N'on_hold', N'approved', N'rejected', N'withdrawn')),
  stage            NVARCHAR(50) NOT NULL CONSTRAINT df_change_requests_stage DEFAULT N'head' CONSTRAINT ck_change_requests_stage CHECK (stage IN (N'head', N'pmo')),
  head_by          INT NULL CONSTRAINT fk_change_requests_head FOREIGN KEY REFERENCES dbo.users(id),
  head_at          DATETIMEOFFSET(3) NULL,
  head_note        NVARCHAR(MAX) NULL,
  head_skipped     NVARCHAR(MAX) NULL,
  decided_by       INT NULL CONSTRAINT fk_change_requests_decided FOREIGN KEY REFERENCES dbo.users(id),
  decided_at       DATETIMEOFFSET(3) NULL,
  decision_note    NVARCHAR(MAX) NULL,
  applied          NVARCHAR(MAX) NULL CONSTRAINT ck_change_requests_applied CHECK (applied IS NULL OR ISJSON(applied) = 1),
  progress         NVARCHAR(MAX) NOT NULL CONSTRAINT df_change_requests_progress DEFAULT N'',
  completion_date  DATE NULL,
  notes            NVARCHAR(MAX) NOT NULL CONSTRAINT df_change_requests_notes DEFAULT N''
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'change_requests_seq_idx' AND object_id = OBJECT_ID(N'dbo.change_requests'))
CREATE UNIQUE INDEX change_requests_seq_idx ON dbo.change_requests(project_id, seq);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'change_requests_status_idx' AND object_id = OBJECT_ID(N'dbo.change_requests'))
CREATE INDEX change_requests_status_idx ON dbo.change_requests(status, stage);
GO

-- One row for each email sent once only (such as the weekly reminder), so a restart never repeats it.
IF OBJECT_ID(N'dbo.email_sent', N'U') IS NULL
CREATE TABLE dbo.email_sent (
  user_id  INT NOT NULL CONSTRAINT fk_email_sent_user FOREIGN KEY REFERENCES dbo.users(id),
  [key]    NVARCHAR(450) NOT NULL,
  sent_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_email_sent_at DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT pk_email_sent PRIMARY KEY (user_id, [key])
);
GO

-- Official holidays, one row a day (Friday and Saturday are off without a row). Kept by the PMO.
IF OBJECT_ID(N'dbo.holidays', N'U') IS NULL
CREATE TABLE dbo.holidays (
  day         DATE NOT NULL CONSTRAINT pk_holidays PRIMARY KEY,
  name        NVARCHAR(MAX) NOT NULL,
  name_ar     NVARCHAR(MAX) NOT NULL CONSTRAINT df_holidays_name_ar DEFAULT N'',
  created_by  INT NULL CONSTRAINT fk_holidays_created_by FOREIGN KEY REFERENCES dbo.users(id),
  created_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_holidays_created DEFAULT SYSDATETIMEOFFSET()
);
GO

-- A milestone the system keeps in every plan (closure_docs: the documents that prove the project is done).
IF COL_LENGTH(N'dbo.tasks', N'system_key') IS NULL ALTER TABLE dbo.tasks ADD system_key NVARCHAR(450) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'tasks_system_key_idx' AND object_id = OBJECT_ID(N'dbo.tasks'))
CREATE UNIQUE INDEX tasks_system_key_idx ON dbo.tasks(project_id, system_key) WHERE system_key IS NOT NULL;
GO

-- A change asked for by email, waiting for the person to reply YES (then done through the normal API, as them).
IF OBJECT_ID(N'dbo.email_actions', N'U') IS NULL
CREATE TABLE dbo.email_actions (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_email_actions PRIMARY KEY,
  user_id     INT NOT NULL CONSTRAINT fk_email_actions_user FOREIGN KEY REFERENCES dbo.users(id),
  project_id  INT NULL,
  summary     NVARCHAR(MAX) NOT NULL,
  request     NVARCHAR(MAX) NOT NULL CONSTRAINT ck_email_actions_request CHECK (ISJSON(request) = 1),
  created_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_email_actions_created DEFAULT SYSDATETIMEOFFSET(),
  done_at     DATETIMEOFFSET(3) NULL,
  result      NVARCHAR(MAX) NULL
);
GO
-- A proposal made in test mode (to the test address): approving it changes nothing.
IF COL_LENGTH(N'dbo.email_actions', N'test') IS NULL ALTER TABLE dbo.email_actions ADD test BIT NOT NULL CONSTRAINT df_email_actions_test DEFAULT 0;
GO

-- The daily follow-up agent: each milestone asked about, to whom and why (spaces the reminders, counts them).
IF OBJECT_ID(N'dbo.followups', N'U') IS NULL
CREATE TABLE dbo.followups (
  id       INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_followups PRIMARY KEY,
  task_id  INT NOT NULL CONSTRAINT fk_followups_task FOREIGN KEY REFERENCES dbo.tasks(id),
  user_id  INT NULL CONSTRAINT fk_followups_user FOREIGN KEY REFERENCES dbo.users(id),
  sent_to  NVARCHAR(MAX) NOT NULL,
  reason   NVARCHAR(MAX) NOT NULL,
  sent_on  DATE NOT NULL,
  sent_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_followups_sent_at DEFAULT SYSDATETIMEOFFSET()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'followups_task' AND object_id = OBJECT_ID(N'dbo.followups'))
CREATE INDEX followups_task ON dbo.followups(task_id, sent_on);
GO
-- Test-mode follow-ups (sent to the test address) are kept apart: they never count for the real owners.
IF COL_LENGTH(N'dbo.followups', N'test') IS NULL ALTER TABLE dbo.followups ADD test BIT NOT NULL CONSTRAINT df_followups_test DEFAULT 0;
GO

-- Scheduled jobs that run once a day: one row per job and day, so a restart or a second server does not repeat it.
IF OBJECT_ID(N'dbo.job_runs', N'U') IS NULL
CREATE TABLE dbo.job_runs (
  [key]   NVARCHAR(450) NOT NULL CONSTRAINT pk_job_runs PRIMARY KEY,
  ran_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_job_runs_ran DEFAULT SYSDATETIMEOFFSET()
);
GO

-- The weekly AI recommendations on a project: when, to whom, and the proposal they became.
IF OBJECT_ID(N'dbo.recommendations', N'U') IS NULL
CREATE TABLE dbo.recommendations (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_recommendations PRIMARY KEY,
  project_id  INT NOT NULL CONSTRAINT fk_recommendations_project FOREIGN KEY REFERENCES dbo.projects(id),
  sent_to     NVARCHAR(MAX) NOT NULL,
  action_id   INT NULL CONSTRAINT fk_recommendations_action FOREIGN KEY REFERENCES dbo.email_actions(id),
  sent_on     DATE NOT NULL,
  test        BIT NOT NULL CONSTRAINT df_recommendations_test DEFAULT 0
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'recommendations_project' AND object_id = OBJECT_ID(N'dbo.recommendations'))
CREATE INDEX recommendations_project ON dbo.recommendations(project_id, sent_on);
GO

-- Five stages (Monitoring & Control added, Closed folded into Closure: a finished project is Closure + health done).
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_projects_stage' AND parent_object_id = OBJECT_ID(N'dbo.projects') AND definition LIKE N'%closed%')
  ALTER TABLE dbo.projects DROP CONSTRAINT ck_projects_stage;
GO
UPDATE dbo.projects SET stage = N'closure', health = N'done' WHERE stage = N'closed';
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_projects_stage' AND parent_object_id = OBJECT_ID(N'dbo.projects'))
  ALTER TABLE dbo.projects ADD CONSTRAINT ck_projects_stage CHECK (stage IN (N'initiation', N'planning', N'execution', N'monitoring', N'closure'));
GO

-- What each stage states when the project is created (shared/stageRequirements.ts).
IF COL_LENGTH(N'dbo.projects', N'problem_statement') IS NULL ALTER TABLE dbo.projects ADD problem_statement NVARCHAR(MAX) NULL;
IF COL_LENGTH(N'dbo.projects', N'stakeholders') IS NULL ALTER TABLE dbo.projects ADD stakeholders NVARCHAR(MAX) NULL;
IF COL_LENGTH(N'dbo.projects', N'business_case') IS NULL ALTER TABLE dbo.projects ADD business_case NVARCHAR(MAX) NULL;
IF COL_LENGTH(N'dbo.projects', N'resources') IS NULL ALTER TABLE dbo.projects ADD resources NVARCHAR(MAX) NULL;
IF COL_LENGTH(N'dbo.projects', N'risk_plan') IS NULL ALTER TABLE dbo.projects ADD risk_plan NVARCHAR(MAX) NULL;
IF COL_LENGTH(N'dbo.projects', N'deliverables') IS NULL ALTER TABLE dbo.projects ADD deliverables NVARCHAR(MAX) NULL;
IF COL_LENGTH(N'dbo.projects', N'acceptance_criteria') IS NULL ALTER TABLE dbo.projects ADD acceptance_criteria NVARCHAR(MAX) NULL;
GO

-- Meeting notes belong to the project and week (an update may not be filed); an action has an owner and a due date.
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.meeting_notes') AND name = N'update_id' AND is_nullable = 0)
  ALTER TABLE dbo.meeting_notes ALTER COLUMN update_id INT NULL;
GO
IF COL_LENGTH(N'dbo.meeting_notes', N'project_id') IS NULL ALTER TABLE dbo.meeting_notes ADD project_id INT NULL CONSTRAINT fk_meeting_notes_project FOREIGN KEY REFERENCES dbo.projects(id);
IF COL_LENGTH(N'dbo.meeting_notes', N'week_start') IS NULL ALTER TABLE dbo.meeting_notes ADD week_start DATE NULL;
IF COL_LENGTH(N'dbo.meeting_notes', N'owner_id') IS NULL ALTER TABLE dbo.meeting_notes ADD owner_id INT NULL CONSTRAINT fk_meeting_notes_owner FOREIGN KEY REFERENCES dbo.users(id);
IF COL_LENGTH(N'dbo.meeting_notes', N'due_date') IS NULL ALTER TABLE dbo.meeting_notes ADD due_date DATE NULL;
IF COL_LENGTH(N'dbo.meeting_notes', N'done_at') IS NULL ALTER TABLE dbo.meeting_notes ADD done_at DATETIMEOFFSET(3) NULL;
GO
-- A blocker on the whole project, raised in the meeting; open until cleared (done_at).
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_meeting_notes_kind' AND parent_object_id = OBJECT_ID(N'dbo.meeting_notes') AND definition NOT LIKE N'%decision_needed%')
  ALTER TABLE dbo.meeting_notes DROP CONSTRAINT ck_meeting_notes_kind;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_meeting_notes_kind' AND parent_object_id = OBJECT_ID(N'dbo.meeting_notes'))
  ALTER TABLE dbo.meeting_notes ADD CONSTRAINT ck_meeting_notes_kind CHECK (kind IN (N'comment', N'decision', N'action', N'blocker', N'decision_needed'));
GO
UPDATE n SET project_id = s.project_id, week_start = s.week_start
  FROM dbo.meeting_notes n JOIN dbo.status_updates s ON s.id = n.update_id
 WHERE n.project_id IS NULL;
GO

-- View as: a PMO admin's session may show the app as another person sees it, to test their journey. Nothing is
-- saved while it is on (the server refuses every change).
IF COL_LENGTH(N'dbo.sessions', N'view_as_user_id') IS NULL ALTER TABLE dbo.sessions ADD view_as_user_id INT NULL CONSTRAINT fk_sessions_view_as FOREIGN KEY REFERENCES dbo.users(id);
GO

-- When the account's setup email went out. Accounts can be made before launch and emailed later (one by one, or
-- all at once). Accounts that already have a password, or were emailed before this column, count as sent.
IF COL_LENGTH(N'dbo.users', N'setup_emailed_at') IS NULL ALTER TABLE dbo.users ADD setup_emailed_at DATETIMEOFFSET(3) NULL;
GO

-- Work given across departments waits for a decision: the other department's head picks or approves the person,
-- a system admin creates the account of someone new. user_id NULL and no new_email means "the head picks".
IF OBJECT_ID(N'dbo.owner_requests', N'U') IS NULL
CREATE TABLE dbo.owner_requests (
  id             INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_owner_requests PRIMARY KEY,
  task_id        INT NOT NULL CONSTRAINT fk_owner_requests_task FOREIGN KEY REFERENCES dbo.tasks(id),
  department_id  INT NOT NULL CONSTRAINT fk_owner_requests_department FOREIGN KEY REFERENCES dbo.departments(id),
  user_id        INT NULL CONSTRAINT fk_owner_requests_user FOREIGN KEY REFERENCES dbo.users(id),
  new_name       NVARCHAR(MAX) NULL,
  new_email      NVARCHAR(MAX) NULL,
  requested_by   INT NULL CONSTRAINT fk_owner_requests_requested FOREIGN KEY REFERENCES dbo.users(id),
  requested_at   DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_owner_requests_requested DEFAULT SYSDATETIMEOFFSET(),
  status         NVARCHAR(50) NOT NULL CONSTRAINT df_owner_requests_status DEFAULT N'pending',
  decided_by     INT NULL CONSTRAINT fk_owner_requests_decided FOREIGN KEY REFERENCES dbo.users(id),
  decided_at     DATETIMEOFFSET(3) NULL,
  note           NVARCHAR(MAX) NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'owner_requests_pending' AND object_id = OBJECT_ID(N'dbo.owner_requests'))
CREATE INDEX owner_requests_pending ON dbo.owner_requests(task_id) WHERE status = N'pending';
GO

-- The staff directory (org chart): everyone, with or without an account, their department, position and direct
-- manager. An account is linked to its person by email.
IF OBJECT_ID(N'dbo.staff', N'U') IS NULL
CREATE TABLE dbo.staff (
  id             INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_staff PRIMARY KEY,
  emp_no         NVARCHAR(450) NULL,
  name           NVARCHAR(MAX) NOT NULL,
  email          NVARCHAR(450) NULL,
  department_id  INT NULL CONSTRAINT fk_staff_department FOREIGN KEY REFERENCES dbo.departments(id),
  position       NVARCHAR(MAX) NULL,
  manager_id     INT NULL CONSTRAINT fk_staff_manager FOREIGN KEY REFERENCES dbo.staff(id),
  active         BIT NOT NULL CONSTRAINT df_staff_active DEFAULT 1,
  updated_at     DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_staff_updated DEFAULT SYSDATETIMEOFFSET()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'staff_emp_no_idx' AND object_id = OBJECT_ID(N'dbo.staff'))
CREATE UNIQUE INDEX staff_emp_no_idx ON dbo.staff(emp_no) WHERE emp_no IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'staff_email' AND object_id = OBJECT_ID(N'dbo.staff'))
CREATE INDEX staff_email ON dbo.staff(email);
GO
-- Board of Directors: a member's title on the board (Chairman, Vice Chairman, Board Member) and their order.
IF COL_LENGTH(N'dbo.staff', N'board_title') IS NULL ALTER TABLE dbo.staff ADD board_title NVARCHAR(MAX) NULL;
IF COL_LENGTH(N'dbo.staff', N'board_rank') IS NULL ALTER TABLE dbo.staff ADD board_rank INT NULL;
GO

-- Portfolios (capabilities) and programs (dimensions) have a manager who watches the projects under them.
IF COL_LENGTH(N'dbo.capabilities', N'manager_user_id') IS NULL ALTER TABLE dbo.capabilities ADD manager_user_id INT NULL CONSTRAINT fk_capabilities_manager FOREIGN KEY REFERENCES dbo.users(id);
IF COL_LENGTH(N'dbo.dimensions', N'manager_user_id') IS NULL ALTER TABLE dbo.dimensions ADD manager_user_id INT NULL CONSTRAINT fk_dimensions_manager FOREIGN KEY REFERENCES dbo.users(id);
GO
-- The named steps at the top of the escalation ladder: 'ibe' (Integrated Business Excellence) and 'ceo'.
IF OBJECT_ID(N'dbo.ladder_roles', N'U') IS NULL
CREATE TABLE dbo.ladder_roles (
  [key]    NVARCHAR(450) NOT NULL CONSTRAINT pk_ladder_roles PRIMARY KEY,
  user_id  INT NULL CONSTRAINT fk_ladder_roles_user FOREIGN KEY REFERENCES dbo.users(id)
);
GO

-- The AI project manager, switched on per project; what it does is logged. People can be paused or away.
IF COL_LENGTH(N'dbo.projects', N'ai_pm_enabled') IS NULL ALTER TABLE dbo.projects ADD ai_pm_enabled BIT NOT NULL CONSTRAINT df_projects_ai_pm DEFAULT 0;
IF COL_LENGTH(N'dbo.projects', N'ai_pm_since') IS NULL ALTER TABLE dbo.projects ADD ai_pm_since DATETIMEOFFSET(3) NULL;
IF COL_LENGTH(N'dbo.projects', N'ai_pm_by') IS NULL ALTER TABLE dbo.projects ADD ai_pm_by INT NULL CONSTRAINT fk_projects_ai_pm_by FOREIGN KEY REFERENCES dbo.users(id);
IF COL_LENGTH(N'dbo.users', N'ai_paused') IS NULL ALTER TABLE dbo.users ADD ai_paused BIT NOT NULL CONSTRAINT df_users_ai_paused DEFAULT 0;
IF COL_LENGTH(N'dbo.users', N'away_until') IS NULL ALTER TABLE dbo.users ADD away_until DATE NULL;
-- When the person finished (or skipped) the guided tour: it opens by itself only before that.
IF COL_LENGTH(N'dbo.users', N'tour_done_at') IS NULL ALTER TABLE dbo.users ADD tour_done_at DATETIMEOFFSET(3) NULL;
-- The page tours the person has finished or skipped (a JSON list of names): each opens by itself only before that.
IF COL_LENGTH(N'dbo.users', N'tours_seen') IS NULL ALTER TABLE dbo.users ADD tours_seen NVARCHAR(MAX) NOT NULL CONSTRAINT df_users_tours_seen DEFAULT N'[]' CONSTRAINT ck_users_tours_seen CHECK (ISJSON(tours_seen) = 1);
GO
IF OBJECT_ID(N'dbo.ai_pm_log', N'U') IS NULL
CREATE TABLE dbo.ai_pm_log (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_ai_pm_log PRIMARY KEY,
  project_id  INT NOT NULL CONSTRAINT fk_ai_pm_log_project FOREIGN KEY REFERENCES dbo.projects(id),
  task_id     INT NULL CONSTRAINT fk_ai_pm_log_task FOREIGN KEY REFERENCES dbo.tasks(id),
  user_id     INT NULL CONSTRAINT fk_ai_pm_log_user FOREIGN KEY REFERENCES dbo.users(id),
  action      NVARCHAR(MAX) NOT NULL,
  message     NVARCHAR(MAX) NOT NULL,
  created_at  DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_ai_pm_log_created DEFAULT SYSDATETIMEOFFSET()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'ai_pm_log_project' AND object_id = OBJECT_ID(N'dbo.ai_pm_log'))
CREATE INDEX ai_pm_log_project ON dbo.ai_pm_log(project_id, created_at DESC);
GO

-- A project that waits for others to close before it starts. started_before: it was already under way when linked
-- (shown, not frozen).
IF OBJECT_ID(N'dbo.project_dependencies', N'U') IS NULL
CREATE TABLE dbo.project_dependencies (
  project_id      INT NOT NULL CONSTRAINT fk_project_dependencies_project FOREIGN KEY REFERENCES dbo.projects(id),
  depends_on_id   INT NOT NULL CONSTRAINT fk_project_dependencies_depends FOREIGN KEY REFERENCES dbo.projects(id),
  started_before  BIT NOT NULL CONSTRAINT df_project_dependencies_started DEFAULT 0,
  created_by      INT NULL CONSTRAINT fk_project_dependencies_by FOREIGN KEY REFERENCES dbo.users(id),
  created_at      DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_project_dependencies_created DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT pk_project_dependencies PRIMARY KEY (project_id, depends_on_id),
  CONSTRAINT ck_project_dependencies_self CHECK (project_id <> depends_on_id)
);
GO

-- Files attached to a milestone or task: any kind, kept in the database, always served as a download.
IF OBJECT_ID(N'dbo.task_attachments', N'U') IS NULL
CREATE TABLE dbo.task_attachments (
  id           INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_task_attachments PRIMARY KEY,
  task_id      INT NOT NULL CONSTRAINT fk_task_attachments_task FOREIGN KEY REFERENCES dbo.tasks(id),
  name         NVARCHAR(MAX) NOT NULL,
  size         INT NOT NULL,
  data         VARBINARY(MAX) NOT NULL,
  uploaded_by  INT NULL CONSTRAINT fk_task_attachments_by FOREIGN KEY REFERENCES dbo.users(id),
  created_at   DATETIMEOFFSET(3) NOT NULL CONSTRAINT df_task_attachments_created DEFAULT SYSDATETIMEOFFSET()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'task_attachments_task' AND object_id = OBJECT_ID(N'dbo.task_attachments'))
CREATE INDEX task_attachments_task ON dbo.task_attachments(task_id);
GO

-- Team roles come from a fixed list (shared/types.ts TEAM_ROLES). The owner is the Project manager, nobody else.
UPDATE m SET role = N'Member'
  FROM dbo.project_members m
 WHERE role NOT IN (N'Project manager', N'Team lead', N'Member', N'Subject matter expert', N'Stakeholder / Reviewer', N'PMO coordinator')
    OR (role = N'Project manager' AND NOT EXISTS (SELECT 1 FROM dbo.projects p WHERE p.id = m.project_id AND p.manager_id = m.user_id));
GO
UPDATE m SET role = N'Project manager'
  FROM dbo.project_members m JOIN dbo.projects p ON p.id = m.project_id
 WHERE p.manager_id = m.user_id AND m.role <> N'Project manager';
GO

-- The imported tracker comment becomes the first row of each history, once (no author: it came from the import).
INSERT INTO dbo.milestone_updates (task_id, created_at, status, progress, comment, blocker)
SELECT t.id, DATEADD(HOUR, 12, CAST(COALESCE(t.update_comment_on, t.last_update_on, CAST(SYSUTCDATETIME() AS DATE)) AS DATETIMEOFFSET(3))), t.status, t.progress, t.update_comment, t.blocker
  FROM dbo.tasks t
 WHERE t.update_comment IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.milestone_updates m WHERE m.task_id = t.id);
GO

UPDATE u SET setup_emailed_at = COALESCE(u.password_set_at, SYSDATETIMEOFFSET())
  FROM dbo.users u
 WHERE u.setup_emailed_at IS NULL
   AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM dbo.activity a WHERE a.action = N'user.setup_emailed' AND JSON_VALUE(a.detail, '$.email') = u.email))
   AND NOT EXISTS (SELECT 1 FROM dbo.activity a WHERE a.action = N'user.created' AND JSON_VALUE(a.detail, '$.held') = N'true' AND JSON_VALUE(a.detail, '$.email') = u.email);
GO

-- ---------------------------------------------------------------------------------------------------------------
-- Delete rules. PostgreSQL did these with ON DELETE CASCADE and ON DELETE SET NULL. Each trigger replaces the delete
-- with the same effect: first what hangs from the row goes (or is set to NULL), then the row itself.
-- ---------------------------------------------------------------------------------------------------------------

-- A task takes its whole subtree with it, and everything that hangs from those tasks.
CREATE OR ALTER TRIGGER dbo.trg_tasks_delete ON dbo.tasks INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @ids TABLE (id INT PRIMARY KEY);
  WITH sub AS (
    SELECT id FROM deleted
    UNION ALL
    SELECT t.id FROM dbo.tasks t JOIN sub ON t.parent_id = sub.id
  )
  INSERT INTO @ids (id) SELECT DISTINCT id FROM sub OPTION (MAXRECURSION 0);
  DELETE FROM dbo.task_dependencies WHERE predecessor_id IN (SELECT id FROM @ids) OR successor_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.milestone_updates WHERE task_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.deadline_changes WHERE task_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.escalations WHERE task_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.task_coowners WHERE task_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.notifications WHERE task_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.followups WHERE task_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.owner_requests WHERE task_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.task_attachments WHERE task_id IN (SELECT id FROM @ids);
  UPDATE dbo.ai_pm_log SET task_id = NULL WHERE task_id IN (SELECT id FROM @ids);
  DELETE FROM dbo.tasks WHERE id IN (SELECT id FROM @ids);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_status_updates_delete ON dbo.status_updates INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM dbo.meeting_notes WHERE update_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.status_updates WHERE id IN (SELECT id FROM deleted);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_projects_delete ON dbo.projects INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM dbo.project_members WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.task_dependencies WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.tasks WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.status_updates WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.risks WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.activity WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.notifications WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.closure_requests WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.change_requests WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.recommendations WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.meeting_notes WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.ai_pm_log WHERE project_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.project_dependencies WHERE project_id IN (SELECT id FROM deleted) OR depends_on_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.projects WHERE id IN (SELECT id FROM deleted);
END;
GO

-- A user's rows that point at them are set to NULL, and the rows that only exist for them go.
CREATE OR ALTER TRIGGER dbo.trg_users_delete ON dbo.users INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM dbo.sessions WHERE user_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.project_members WHERE user_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.task_coowners WHERE user_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.notifications WHERE user_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.email_sent WHERE user_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.email_actions WHERE user_id IN (SELECT id FROM deleted);
  UPDATE dbo.sessions SET view_as_user_id = NULL WHERE view_as_user_id IN (SELECT id FROM deleted);
  UPDATE dbo.followups SET user_id = NULL WHERE user_id IN (SELECT id FROM deleted);
  UPDATE dbo.owner_requests SET user_id = NULL WHERE user_id IN (SELECT id FROM deleted);
  UPDATE dbo.owner_requests SET requested_by = NULL WHERE requested_by IN (SELECT id FROM deleted);
  UPDATE dbo.owner_requests SET decided_by = NULL WHERE decided_by IN (SELECT id FROM deleted);
  UPDATE dbo.capabilities SET manager_user_id = NULL WHERE manager_user_id IN (SELECT id FROM deleted);
  UPDATE dbo.dimensions SET manager_user_id = NULL WHERE manager_user_id IN (SELECT id FROM deleted);
  UPDATE dbo.ladder_roles SET user_id = NULL WHERE user_id IN (SELECT id FROM deleted);
  UPDATE dbo.projects SET ai_pm_by = NULL WHERE ai_pm_by IN (SELECT id FROM deleted);
  UPDATE dbo.ai_pm_log SET user_id = NULL WHERE user_id IN (SELECT id FROM deleted);
  UPDATE dbo.meeting_notes SET owner_id = NULL WHERE owner_id IN (SELECT id FROM deleted);
  UPDATE dbo.project_dependencies SET created_by = NULL WHERE created_by IN (SELECT id FROM deleted);
  UPDATE dbo.task_attachments SET uploaded_by = NULL WHERE uploaded_by IN (SELECT id FROM deleted);
  UPDATE dbo.users SET invite_issued_by = NULL WHERE invite_issued_by IN (SELECT id FROM deleted);
  UPDATE dbo.users SET password_link_by = NULL WHERE password_link_by IN (SELECT id FROM deleted);
  UPDATE dbo.departments SET head_user_id = NULL WHERE head_user_id IN (SELECT id FROM deleted);
  UPDATE dbo.projects SET manager_id = NULL WHERE manager_id IN (SELECT id FROM deleted);
  UPDATE dbo.projects SET created_by = NULL WHERE created_by IN (SELECT id FROM deleted);
  UPDATE dbo.tasks SET assignee_id = NULL WHERE assignee_id IN (SELECT id FROM deleted);
  UPDATE dbo.status_updates SET author_id = NULL WHERE author_id IN (SELECT id FROM deleted);
  UPDATE dbo.meeting_notes SET author_id = NULL WHERE author_id IN (SELECT id FROM deleted);
  UPDATE dbo.risks SET owner_id = NULL WHERE owner_id IN (SELECT id FROM deleted);
  UPDATE dbo.activity SET user_id = NULL WHERE user_id IN (SELECT id FROM deleted);
  UPDATE dbo.milestone_updates SET author_id = NULL WHERE author_id IN (SELECT id FROM deleted);
  UPDATE dbo.deadline_changes SET requested_by = NULL WHERE requested_by IN (SELECT id FROM deleted);
  UPDATE dbo.deadline_changes SET decided_by = NULL WHERE decided_by IN (SELECT id FROM deleted);
  UPDATE dbo.escalations SET raised_by = NULL WHERE raised_by IN (SELECT id FROM deleted);
  UPDATE dbo.escalations SET resolved_by = NULL WHERE resolved_by IN (SELECT id FROM deleted);
  UPDATE dbo.closure_requests SET requested_by = NULL WHERE requested_by IN (SELECT id FROM deleted);
  UPDATE dbo.closure_requests SET decided_by = NULL WHERE decided_by IN (SELECT id FROM deleted);
  UPDATE dbo.change_requests SET requested_by = NULL WHERE requested_by IN (SELECT id FROM deleted);
  UPDATE dbo.change_requests SET head_by = NULL WHERE head_by IN (SELECT id FROM deleted);
  UPDATE dbo.change_requests SET decided_by = NULL WHERE decided_by IN (SELECT id FROM deleted);
  UPDATE dbo.holidays SET created_by = NULL WHERE created_by IN (SELECT id FROM deleted);
  DELETE FROM dbo.users WHERE id IN (SELECT id FROM deleted);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_departments_delete ON dbo.departments INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.users SET department_id = NULL WHERE department_id IN (SELECT id FROM deleted);
  UPDATE dbo.staff SET department_id = NULL WHERE department_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.owner_requests WHERE department_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.departments WHERE id IN (SELECT id FROM deleted);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_staff_delete ON dbo.staff INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.staff SET manager_id = NULL WHERE manager_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.staff WHERE id IN (SELECT id FROM deleted);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_email_actions_delete ON dbo.email_actions INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.recommendations SET action_id = NULL WHERE action_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.email_actions WHERE id IN (SELECT id FROM deleted);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_quarters_delete ON dbo.quarters INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.projects SET quarter_id = NULL WHERE quarter_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.quarters WHERE id IN (SELECT id FROM deleted);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_initiatives_delete ON dbo.initiatives INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.projects SET initiative_id = NULL WHERE initiative_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.initiatives WHERE id IN (SELECT id FROM deleted);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_dimensions_delete ON dbo.dimensions INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM dbo.initiatives WHERE dimension_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.dimensions WHERE id IN (SELECT id FROM deleted);
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_capabilities_delete ON dbo.capabilities INSTEAD OF DELETE AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM dbo.dimensions WHERE capability_id IN (SELECT id FROM deleted);
  DELETE FROM dbo.capabilities WHERE id IN (SELECT id FROM deleted);
END;
GO
