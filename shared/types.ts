// Shapes shared by the API and the client. Dates travel as ISO 'YYYY-MM-DD'
// strings: a project plan is a calendar, not a timeline of instants, so time
// zones must never shift a milestone by a day.

import type { Permission } from './permissions';
import type { Holiday } from './calendar';
export type { Permission } from './permissions';
export type { Holiday } from './calendar';

export type Health = 'not_started' | 'on_track' | 'at_risk' | 'off_track' | 'done';
/** The five stages of the project lifecycle. A finished project is in Closure with health Done (set by approving its closure). */
export type Stage = 'initiation' | 'planning' | 'execution' | 'monitoring' | 'closure';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type TaskKind = 'summary' | 'task' | 'milestone';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type RiskKind = 'risk' | 'issue';
export type Level = 'low' | 'medium' | 'high';
export type RiskStatus = 'open' | 'mitigating' | 'closed';
export type NoteKind = 'comment' | 'decision' | 'action' | 'blocker' | 'decision_needed';

export const HEALTHS: Health[] = ['on_track', 'at_risk', 'off_track', 'not_started', 'done'];
export const STAGES: Stage[] = ['initiation', 'planning', 'execution', 'monitoring', 'closure'];
export const PRIORITIES: Priority[] = ['critical', 'high', 'medium', 'low'];

export interface User {
  id: number;
  email: string;
  name: string;
  roleId: string;
  title: string | null;
  departmentId: number | null;
  active: boolean;
  /** Added (or reset) by an admin and not set up yet: waits for the person to open their setup link. */
  pending: boolean;
  /** When the current setup link stops working (pending accounts only). */
  inviteExpiresAt: string | null;
  /** False while the setup email has not gone out (held until launch). */
  setupEmailed?: boolean;
  /** The admin who made the current setup link (pending accounts only). */
  inviteIssuedBy: number | null;
  lastLoginAt: string | null;
  /** The protected owner account (OWNER_EMAIL). */
  owner: boolean;
  /** Manages accounts and permissions, like the owner. The owner always is one. */
  systemAdmin: boolean;
  /** The AI project manager does not remind them (set by the PMO). */
  aiPaused?: boolean;
  /** Finished or skipped the guided tour. */
  tourDone?: boolean;
  /** Page tours finished or skipped. */
  toursSeen?: string[];
  /** On leave until this day: no reminders. */
  awayUntil?: string | null;
}

export interface RoleDef {
  id: string;
  name: string;
  nameAr: string;
  permissions: Permission[];
  protected: boolean;
}

/** What the project assistant proposes: reviewed and edited by the person, then sent to the normal creation. */
export interface ProjectDraft {
  name: string;
  nameAr: string;
  departmentId: number;
  /** 0 when not named: the system then uses the department head, or the person creating it. */
  ownerId: number;
  sponsor: string;
  priority: Priority;
  objective: string;
  scope: string;
  /** What each stage must state before the project is created (shared/stageRequirements.ts). */
  problemStatement: string;
  stakeholders: string;
  businessCase: string;
  budget: string;
  resources: string;
  riskPlan: string;
  deliverables: string;
  successMetric: string;
  successTarget: string;
  acceptanceCriteria: string;
  startDate: string;
  endDate: string;
  /** The fixed phases the project needs (shared/phases.ts); the others are created marked Not required. */
  phases: string[];
  /** phase: the fixed phase the milestone sits in (empty: placed by its date). */
  milestones: { name: string; date: string; phase?: string }[];
}

/** One turn of the assistant: what it says, what it decided itself, the whole draft, and what is still missing. */
export interface DraftAnswer {
  reply: string;
  /** What is still needed for a complete project, as questions to the person. Empty when nothing is. */
  questions: string[];
  assumptions: string[];
  draft: ProjectDraft;
  missing: ('name' | 'department' | 'dates')[];
}

/** A project of the transformation plan, with the columns of the PMO's workbook. */
export interface Initiative {
  id: number;
  dimensionId: number;
  name: string;
  type: string | null;
  status: string | null;
  priority: string | null;
  owner: string | null;
  outcome: string | null;
  completionCriteria: string | null;
  outcomeKpi: string | null;
  baseline: string | null;
  target: string | null;
  startDate: string | null;
  targetCompletion: string | null;
  parentInitiative: string | null;
  dependency: string | null;
  /** The projects of the system linked to it (those this person can see). */
  projectIds: number[];
}

export interface Dimension {
  id: number;
  capabilityId: number;
  name: string;
  /** The program manager (watches the projects of this program). */
  managerUserId: number | null;
  initiatives: Initiative[];
}

export interface Capability {
  id: number;
  name: string;
  /** The portfolio manager (watches the projects of this portfolio). */
  managerUserId: number | null;
  dimensions: Dimension[];
}

/** A project of the system and the plan project it is linked to (null until the PMO links it). */
export interface PlanLink {
  projectId: number;
  code: string;
  name: string;
  departmentId: number;
  initiativeId: number | null;
}

/** What a change request proposes. Applied by the system when it is finally approved. */
export interface ProposedChanges {
  startDate?: string;
  endDate?: string;
  /** null clears the budget. */
  budget?: number | null;
  scope?: string;
  objective?: string;
  /** Existing milestones: a new deadline, or cancelled. */
  milestones?: { taskId: number; action: 'move' | 'cancel'; to?: string }[];
  /** New milestones, inside a phase (or at the top of the plan). */
  newMilestones?: { name: string; date: string; parentId: number | null }[];
}

export type ChangeArea = 'scope' | 'cost' | 'schedule';
export type ChangeStatus = 'pending' | 'on_hold' | 'approved' | 'rejected' | 'withdrawn';

/** A change request and its place in the change log. */
export interface ChangeRequest {
  id: number;
  projectId: number;
  /** CR-001, CR-002... within the project. */
  code: string;
  requestedBy: number | null;
  requestedByName: string | null;
  requestedAt: string;
  areas: ChangeArea[];
  description: string;
  reason: string;
  actions: string;
  actionsDate: string | null;
  changes: ProposedChanges;
  /** The values the change replaces, as they were when it was asked for. */
  before: { startDate?: string; endDate?: string; budget?: number | null; scope?: string | null; objective?: string | null; milestones?: { taskId: number; name: string; date: string }[] };
  status: ChangeStatus;
  /** Who it waits for while pending or on hold: the head of the department, then the PMO. */
  stage: 'head' | 'pmo';
  headBy: number | null;
  headByName: string | null;
  headAt: string | null;
  headNote: string | null;
  /** Why the head's approval was not needed (asked by the head, or the department has none). */
  headSkipped: string | null;
  decidedBy: number | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** What the system changed when it was approved, in words. */
  applied: string[] | null;
  progress: string;
  completionDate: string | null;
  notes: string;
}

/** A request to close a project, and what became of it. */
export interface ClosureRequest {
  id: number;
  status: 'pending' | 'approved' | 'rejected';
  note: string;
  requestedBy: number | null;
  requestedByName: string | null;
  createdAt: string;
  decidedBy: number | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** The Delivery Document that came with the request: a link, a file kept in the system, or both. */
  deliveryUrl: string | null;
  deliveryFileName: string | null;
  /** The two documents a project cannot close without. */
  reportFileName: string | null;
  checklistFileName: string | null;
}

export interface Department {
  id: number;
  code: string;
  name: string;
  nameAr: string;
  colorSlot: number;
  /** The department's head, as the old tracker's Departments page kept it. */
  headName: string | null;
  /** The account that heads it: may start projects there and governs all of them. */
  headUserId: number | null;
}

export interface Quarter {
  id: number;
  code: string;
  year: number;
  q: number;
  startsOn: string;
  endsOn: string;
}

export interface ProjectSummary {
  /** The AI project manager follows this project up. */
  aiPmEnabled?: boolean;
  aiPmSince?: string | null;
  id: number;
  /** Open projects it waits for before it may start (empty when free). */
  blockedBy?: { id: number; code: string; name: string }[];
  /** The project of the transformation plan this project delivers (Capability > Dimension > plan project). */
  initiativeId: number | null;
  code: string;
  name: string;
  nameAr: string | null;
  departmentId: number;
  managerId: number | null;
  /** Linked user's name, else the owner's name as written in the tracker. */
  managerName: string | null;
  sponsor: string | null;
  quarterId: number | null;
  priority: Priority;
  stage: Stage;
  health: Health;
  startDate: string;
  endDate: string;
  baselineEnd: string | null;
  /** The committed finish: the latest baseline date of its items (else the project's own baseline). */
  baselineFinish: string | null;
  /** Days the baselined items now finish after (+) or before (-) that; null without a baseline. */
  baselineSlip: number | null;
  progress: number;
  budget: number | null;
  milestones: MilestoneLite[];
  /** The earliest open blocker and the latest milestone comment, from the tracker. */
  blocker: string | null;
  lastComment: string | null;
  lastUpdateWeek: string | null;
  openRisks: number;
}

export interface MilestoneLite {
  id: number;
  name: string;
  date: string;
  baselineDate: string | null;
  done: boolean;
}

export interface Project extends ProjectSummary {
  description: string | null;
  objective: string | null;
  scope: string | null;
  baselineStart: string | null;
  gate: string | null;
  successMetric: string | null;
  successTarget: string | null;
  problemStatement: string | null;
  stakeholders: string | null;
  businessCase: string | null;
  resources: string | null;
  riskPlan: string | null;
  deliverables: string | null;
  acceptanceCriteria: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: number;
  /** A milestone the system keeps in every plan: 'closure_docs' (the documents that prove the project is done). */
  systemKey?: string | null;
  projectId: number;
  parentId: number | null;
  kind: TaskKind;
  /** Tracker milestone code such as ERPFIN1-01. */
  code: string | null;
  name: string;
  startDate: string;
  endDate: string;
  baselineStart: string | null;
  baselineEnd: string | null;
  progress: number;
  status: TaskStatus;
  assigneeId: number | null;
  sort: number;
  notes: string | null;
  ownerName: string | null;
  coOwners: string | null;
  responsibleDept: string | null;
  escalateTo: string | null;
  blocker: string | null;
  dependencyType: string | null;
  lastUpdateOn: string | null;
  updateComment: string | null;
  stream: string | null;
  /** A phase the project does not need: it stays in the plan, marked, so every project reads the same way. */
  notRequired: boolean;
}

export interface Dependency {
  id: number;
  predecessorId: number;
  successorId: number;
  lagDays: number;
}

export interface Member {
  userId: number;
  role: string;
}

export interface StatusUpdate {
  id: number;
  projectId: number;
  weekStart: string;
  health: Health;
  progress: number;
  accomplishments: string;
  nextSteps: string;
  blockers: string;
  decisions: string;
  authorId: number | null;
  submittedAt: string;
  notes: MeetingNote[];
}

export interface MeetingNote {
  id: number;
  updateId: number | null;
  kind: NoteKind;
  body: string;
  authorId: number | null;
  createdAt: string;
  projectId: number | null;
  week: string | null;
  /** An action's owner and due date; done once it is closed. */
  ownerId: number | null;
  dueDate: string | null;
  doneAt: string | null;
  ownerName?: string | null;
  authorName?: string | null;
}

export interface Risk {
  id: number;
  projectId: number;
  kind: RiskKind;
  title: string;
  impact: Level;
  likelihood: Level;
  status: RiskStatus;
  ownerId: number | null;
  mitigation: string | null;
  dueDate: string | null;
  createdAt: string;
}

export interface Activity {
  id: number;
  projectId: number | null;
  userId: number | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** A project another one waits for. */
/** Engagement & delivery insights for one person (the PMO sees all of it; each person sees label and tip). */
export interface PersonInsight {
  userId: number;
  name: string;
  title: string | null;
  department: string | null;
  /** Open milestones given to them now. */
  load: number;
  /** Milestones due in the period. */
  items: number;
  onTimePct: number;
  updatesOnTimePct: number;
  /** Average days from a reminder or escalation to their next update; null when none reached them. */
  replyDays: number | null;
  delayCausedDays: number;
  score: number | null;
  label: 'strong' | 'on_track' | 'attention' | 'not_enough';
  tip: 'deadlines' | 'updates' | 'replies' | 'dependencies' | null;
  summary: string;
}

/** One thing the AI project manager did on a project. */
export interface AiPmEntry {
  id: number;
  taskId: number | null;
  action: 'reminder' | 'escalation' | 'weekly_draft' | string;
  message: string;
  createdAt: string;
}

export interface ProjectLink {
  id: number;
  code: string;
  name: string;
  endDate: string;
  /** Not closed yet (and not archived). */
  open: boolean;
  /** The waiting project had already started when linked: shown, not frozen. */
  startedBefore: boolean;
}

export interface ProjectDetail {
  project: Project;
  /** The projects this one waits for (set by the PMO). */
  dependsOn: ProjectLink[];
  members: Member[];
  tasks: Task[];
  dependencies: Dependency[];
  updates: StatusUpdate[];
  risks: Risk[];
  activity: Activity[];
  /** Everything noted in the weekly meetings, oldest first. */
  meetingNotes: MeetingNote[];
  /** The latest request to close this project, if there ever was one. */
  closure: ClosureRequest | null;
}

/** One milestone on the portfolio-wide Milestones page. */
export interface MilestoneRow {
  id: number;
  projectId: number;
  projectCode: string;
  projectName: string;
  projectNameAr: string | null;
  departmentId: number;
  projectHealth: Health;
  code: string | null;
  name: string;
  date: string;
  baselineDate: string | null;
  status: TaskStatus;
  progress: number;
  ownerName: string | null;
  coOwners: string | null;
  responsibleDept: string | null;
  escalateTo: string | null;
  blocker: string | null;
  lastUpdateOn: string | null;
  updateComment: string | null;
  assigneeId: number | null;
  /** The day the first escalation was raised, if any. */
  escalatedOn: string | null;
  openEscalations: number;
  /** Deadline changes waiting for the project manager or the PMO. */
  pendingChanges: number;
  /** False when this person may see the milestone but not open it (not theirs). */
  openable?: boolean;
  /** Given to the viewer, as owner or co-owner. */
  mine?: boolean;
  notRequired?: boolean;
}

/** One report posted on a task or milestone: the state after it, and what was said. */
export interface MilestoneUpdate {
  id: number;
  taskId: number;
  /** Null for the row the tracker import left behind. */
  authorId: number | null;
  createdAt: string;
  status: TaskStatus;
  progress: number;
  comment: string | null;
  blocker: string | null;
}

/** A move of a milestone's deadline, and why. */
export interface DeadlineChange {
  id: number;
  taskId: number;
  fromDate: string;
  toDate: string;
  reason: string;
  requestedBy: number | null;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy: number | null;
  decidedAt: string | null;
  /** Moved along by a predecessor, not asked for by a person. */
  automatic: boolean;
}

/** One step up the escalation ladder on a milestone. */
export interface Escalation {
  id: number;
  taskId: number;
  level: number;
  raisedBy: number | null;
  toName: string;
  note: string | null;
  raisedAt: string;
  resolvedAt: string | null;
  resolvedBy: number | null;
}

/** A name the plans mention: a person, a team or role, or an outside party. */
export interface DirectoryEntry {
  name: string;
  kind: 'person' | 'team' | 'external';
  projects: number;
  sponsored: number;
  milestones: number;
  openMilestones: number;
  overdue: number;
  coOwned: number;
  escalations: number;
  userId: number | null;
}

export interface Meta {
  me: User;
  /** Set while a PMO admin views the app as "me": the admin's name. Nothing is saved meanwhile. */
  viewingAs?: { by: string } | null;
  /** This sign-in, as an opaque marker (the pop-up opens afresh on a new sign-in). */
  session?: string;
  /** When my password was last set, and the admin whose setup link set it (null: I changed it myself). */
  myPassword: { setAt: string | null; viaLinkFrom: string | null };
  permissions: Permission[];
  isOwner: boolean;
  /** True while the person is still on the temporary password they were emailed: they must choose their own. */
  mustChangePassword: boolean;
  /** Whether the server can send the first-sign-in email (mail settings present). */
  emailSignIn: boolean;
  /** Owner or system admin: may add accounts and edit roles. */
  canManageUsers: boolean;
  /** Manages a portfolio or a program of the transformation plan (watches its projects). */
  managesPlan: boolean;
  roles: RoleDef[];
  users: User[];
  departments: Department[];
  quarters: Quarter[];
  currentQuarterId: number | null;
  today: string;
  /** Official holidays, oldest first (the weekend is Friday and Saturday without rows). */
  holidays: Holiday[];
}

/** A person's role on a project team: a fixed list, so reports and filters read one way. The project manager is the
 * project owner and is never picked; everyone else gets one of the others ('Member' by default). */
export const TEAM_ROLES = ['Project manager', 'Team lead', 'Member', 'Subject matter expert', 'Stakeholder / Reviewer', 'PMO coordinator'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** One step of a project's escalation ladder: project manager, department head (or initiative owner), PMO, executives. */
export interface EscalationStep {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  role: 'pm' | 'program' | 'portfolio' | 'pmo' | 'ibe' | 'ceo';
  /** Who it goes to, as shown and recorded. */
  name: string;
  /** False when nobody on this step has an account: they would not be told. */
  hasAccount: boolean;
}

/** Something waiting for this person to act on, shown in the "Needs your action" pop-up. */
/** Someone in the staff directory (the org chart), with or without an account. */
export interface StaffMember {
  id: number;
  empNo: string | null;
  name: string;
  email: string | null;
  departmentId: number | null;
  position: string | null;
  /** Their direct manager, in the directory. */
  managerId: number | null;
  /** The account with the same email, if any. */
  userId: number | null;
  active: boolean;
  /** On the Board of Directors: their title there (Chairman of the Board, Board Member), and their order. */
  boardTitle: string | null;
  boardRank: number | null;
}

/** A request for an owner from outside the project's department, waiting for that department (or a system admin). */
export interface OwnerRequest {
  id: number;
  taskId: number;
  taskName: string;
  projectId: number;
  projectCode: string;
  projectName: string;
  departmentId: number;
  departmentName: string;
  /** department: its head picks; person: their head approves; new: a system admin creates the account. */
  kind: 'department' | 'person' | 'new';
  userId: number | null;
  userName: string | null;
  newEmail: string | null;
  requestedBy: string | null;
  requestedAt: string;
  status: 'pending' | 'approved' | 'declined' | 'cancelled';
  note: string | null;
  /** In the inbox: the people of that department the head may pick. */
  candidates?: { id: number; name: string }[];
}

export interface MyAction {
  /** Stable per item and state: a new level or a new count is a new key, so it shows again. */
  key: string;
  kind: 'escalation' | 'date_change' | 'change_request' | 'closure' | 'baseline' | 'due' | 'no_owner' | 'owner_request' | 'can_start' | 'mention' | 'note';
  projectId: number;
  projectCode: string;
  taskId?: number;
  title: string;
  level?: number;
  /** Working days the escalation has waited. */
  days?: number;
  date?: string;
  count?: number;
  /** A baseline item: the plan has never been baselined. */
  first?: boolean;
  /** A mention: the notification it comes from (read when opened), who wrote and what. */
  noteId?: number;
  /** A notice: the notification it shows (its kind and data). */
  noteKind?: string;
  noteData?: Record<string, unknown>;
  by?: string;
  excerpt?: string;
}
