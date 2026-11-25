import type { DeadlineChange, Escalation, MilestoneUpdate } from '../shared/types';
import type { Holiday } from '../shared/calendar';
import type { ClosureRequest } from '../shared/types';
// Row (snake_case) to API (camelCase) mapping, one place per entity.
import type {
  Activity,
  Dependency,
  Department,
  MeetingNote,
  Project,
  Quarter,
  Risk,
  RoleDef,
  StatusUpdate,
  Task,
  User,
} from '../shared/types';
import { normalizePermissions } from '../shared/permissions';
import { isOwnerEmail } from './ownerEmails';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mapUser(r: any): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    roleId: r.role_id,
    title: r.title ?? null,
    aiPaused: Boolean(r.ai_paused),
    tourDone: Boolean(r.tour_done_at),
    toursSeen: (r.tours_seen as string[] | null) ?? [],
    awayUntil: r.away_until ? (r.away_until instanceof Date ? r.away_until.toISOString().slice(0, 10) : String(r.away_until).slice(0, 10)) : null,
    departmentId: r.department_id ?? null,
    active: r.active,
    pending: Boolean(r.must_set_password || r.temp_password),
    inviteExpiresAt: r.must_set_password && r.invite_expires_at ? iso(r.invite_expires_at) : null,
    inviteIssuedBy: r.must_set_password ? (r.invite_issued_by ?? null) : null,
    lastLoginAt: r.last_login_at ? iso(r.last_login_at) : null,
    /** False while the account's setup email has not gone out (held until launch). */
    setupEmailed: r.setup_emailed_at !== undefined ? r.setup_emailed_at !== null : undefined,
    owner: isOwnerEmail(String(r.email)),
    systemAdmin: Boolean(r.is_system_admin) || isOwnerEmail(String(r.email)),
  };
}

export function mapRole(r: any): RoleDef {
  return {
    id: r.id,
    name: r.name,
    nameAr: r.name_ar ?? '',
    permissions: normalizePermissions(r.permissions),
    protected: Boolean(r.protected),
  };
}

export function mapDepartment(r: any): Department {
  return { id: r.id, code: r.code, name: r.name, nameAr: r.name_ar, colorSlot: r.color_slot, headName: r.head_name ?? null, headUserId: r.head_user_id ?? null };
}

export function mapClosure(r: any): ClosureRequest {
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    id: r.id,
    status: r.status,
    note: r.note ?? '',
    requestedBy: r.requested_by ?? null,
    requestedByName: r.requested_by_name ?? null,
    createdAt: iso(r.created_at) as string,
    decidedBy: r.decided_by ?? null,
    decidedByName: r.decided_by_name ?? null,
    decidedAt: iso(r.decided_at),
    decisionNote: r.decision_note ?? null,
    deliveryUrl: r.delivery_url ?? null,
    deliveryFileName: r.delivery_file_name ?? null,
    reportFileName: r.report_file_name ?? null,
    checklistFileName: r.checklist_file_name ?? null,
  };
}

export function mapHoliday(r: any): Holiday {
  return { date: r.day, name: r.name, nameAr: r.name_ar ?? '' };
}

export function mapQuarter(r: any): Quarter {
  return { id: r.id, code: r.code, year: r.year, q: r.q, startsOn: r.starts_on, endsOn: r.ends_on };
}

export function mapProject(r: any): Project {
  return {
    aiPmEnabled: Boolean(r.ai_pm_enabled),
    aiPmSince: r.ai_pm_since ? new Date(r.ai_pm_since).toISOString() : null,
    id: r.id,
    initiativeId: r.initiative_id ?? null,
    code: r.code,
    name: r.name,
    nameAr: r.name_ar ?? null,
    description: r.description ?? null,
    objective: r.objective ?? null,
    scope: r.scope ?? null,
    departmentId: r.department_id,
    managerId: r.manager_id ?? null,
    managerName: r.manager_name ?? r.owner_name ?? null,
    gate: r.gate ?? null,
    successMetric: r.success_metric ?? null,
    successTarget: r.success_target ?? null,
    problemStatement: r.problem_statement ?? null,
    stakeholders: r.stakeholders ?? null,
    businessCase: r.business_case ?? null,
    resources: r.resources ?? null,
    riskPlan: r.risk_plan ?? null,
    deliverables: r.deliverables ?? null,
    acceptanceCriteria: r.acceptance_criteria ?? null,
    sponsor: r.sponsor ?? null,
    quarterId: r.quarter_id ?? null,
    priority: r.priority,
    stage: r.stage,
    health: r.health,
    startDate: r.start_date,
    endDate: r.end_date,
    baselineStart: r.baseline_start ?? null,
    baselineEnd: r.baseline_end ?? null,
    baselineFinish: r.plan_baseline_end ?? r.baseline_end ?? null,
    baselineSlip: r.plan_slip !== undefined && r.plan_slip !== null ? Number(r.plan_slip) : null,
    progress: r.progress,
    budget: num(r.budget),
    blocker: r.blocker ?? null,
    lastComment: r.last_comment ?? null,
    milestones: r.milestones ?? [],
    lastUpdateWeek: r.last_update_week ?? null,
    openRisks: Number(r.open_risks ?? 0),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function mapTask(r: any): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id ?? null,
    kind: r.kind,
    code: r.code ?? null,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    baselineStart: r.baseline_start ?? null,
    baselineEnd: r.baseline_end ?? null,
    progress: r.progress,
    status: r.status,
    assigneeId: r.assignee_id ?? null,
    sort: r.sort,
    notes: r.notes ?? null,
    systemKey: r.system_key ?? null,
    ownerName: r.owner_name ?? null,
    coOwners: r.co_owners ?? null,
    responsibleDept: r.responsible_dept ?? null,
    escalateTo: r.escalate_to ?? null,
    blocker: r.blocker ?? null,
    dependencyType: r.dependency_type ?? null,
    lastUpdateOn: r.last_update_on ?? null,
    updateComment: r.update_comment ?? null,
    stream: r.stream ?? null,
    notRequired: Boolean(r.not_required),
  };
}

export function mapDependency(r: any): Dependency {
  return { id: r.id, predecessorId: r.predecessor_id, successorId: r.successor_id, lagDays: r.lag_days };
}

export function mapNote(r: any): MeetingNote {
  return {
    id: r.id,
    updateId: r.update_id ?? null,
    kind: r.kind,
    body: r.body,
    authorId: r.author_id ?? null,
    createdAt: iso(r.created_at),
    projectId: r.project_id ?? null,
    week: r.week_start ?? null,
    ownerId: r.owner_id ?? null,
    dueDate: r.due_date ?? null,
    doneAt: r.done_at ? iso(r.done_at) : null,
    ...(r.author_name !== undefined ? { authorName: r.author_name } : {}),
    ...(r.owner_name !== undefined ? { ownerName: r.owner_name } : {}),
  };
}

export function mapUpdate(r: any, notes: MeetingNote[] = []): StatusUpdate {
  return {
    id: r.id,
    projectId: r.project_id,
    weekStart: r.week_start,
    health: r.health,
    progress: r.progress,
    accomplishments: r.accomplishments,
    nextSteps: r.next_steps,
    blockers: r.blockers,
    decisions: r.decisions,
    authorId: r.author_id ?? null,
    submittedAt: iso(r.submitted_at),
    notes,
  };
}

export function mapRisk(r: any): Risk {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    title: r.title,
    impact: r.impact,
    likelihood: r.likelihood,
    status: r.status,
    ownerId: r.owner_id ?? null,
    mitigation: r.mitigation ?? null,
    dueDate: r.due_date ?? null,
    createdAt: iso(r.created_at),
  };
}

export function mapActivity(r: any): Activity {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    userId: r.user_id ?? null,
    action: r.action,
    detail: r.detail ?? {},
    createdAt: iso(r.created_at),
  };
}

export function mapMilestoneUpdate(r: any): MilestoneUpdate {
  return {
    id: r.id,
    taskId: r.task_id,
    authorId: r.author_id ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    status: r.status,
    progress: r.progress,
    comment: r.comment ?? null,
    blocker: r.blocker ?? null,
  };
}

export function mapDeadlineChange(r: any): DeadlineChange {
  return {
    id: r.id,
    taskId: r.task_id,
    fromDate: r.from_date,
    toDate: r.to_date,
    reason: r.reason,
    requestedBy: r.requested_by ?? null,
    requestedAt: new Date(r.requested_at).toISOString(),
    status: r.status,
    decidedBy: r.decided_by ?? null,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    automatic: Boolean(r.automatic),
  };
}

export function mapEscalation(r: any): Escalation {
  return {
    id: r.id,
    taskId: r.task_id,
    level: r.level,
    raisedBy: r.raised_by ?? null,
    toName: r.to_name,
    note: r.note ?? null,
    raisedAt: new Date(r.raised_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    resolvedBy: r.resolved_by ?? null,
  };
}
