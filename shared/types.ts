// Shapes shared by the API and the client. Dates travel as ISO 'YYYY-MM-DD'
// strings: a project plan is a calendar, not a timeline of instants, so time
// zones must never shift a milestone by a day.

import type { Permission } from './permissions';
import type { Holiday } from './calendar';
export type { Permission } from './permissions';
export type { Holiday } from './calendar';

export type Health = 'not_started' | 'on_track' | 'at_risk' | 'off_track' | 'done';
export type Stage = 'initiation' | 'planning' | 'execution' | 'closure' | 'closed';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type TaskKind = 'summary' | 'task' | 'milestone';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type RiskKind = 'risk' | 'issue';
export type Level = 'low' | 'medium' | 'high';
export type RiskStatus = 'open' | 'mitigating' | 'closed';
export type NoteKind = 'comment' | 'decision' | 'action';

export const HEALTHS: Health[] = ['on_track', 'at_risk', 'off_track', 'not_started', 'done'];
export const STAGES: Stage[] = ['initiation', 'planning', 'execution', 'closure', 'closed'];
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
  /** The admin who made the current setup link (pending accounts only). */
  inviteIssuedBy: number | null;
  lastLoginAt: string | null;
  /** The protected owner account (OWNER_EMAIL). */
  owner: boolean;
  /** Manages accounts and permissions, like the owner. The owner always is one. */
  systemAdmin: boolean;
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
  initiatives: Initiative[];
}

export interface Capability {
  id: number;
  name: string;
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
  id: number;
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
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: number;
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
  updateId: number;
  kind: NoteKind;
  body: string;
  authorId: number | null;
  createdAt: string;
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

export interface ProjectDetail {
  project: Project;
  members: Member[];
  tasks: Task[];
  dependencies: Dependency[];
  updates: StatusUpdate[];
  risks: Risk[];
  activity: Activity[];
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
  roles: RoleDef[];
  users: User[];
  departments: Department[];
  quarters: Quarter[];
  currentQuarterId: number | null;
  today: string;
  /** Official holidays, oldest first (the weekend is Friday and Saturday without rows). */
  holidays: Holiday[];
}
