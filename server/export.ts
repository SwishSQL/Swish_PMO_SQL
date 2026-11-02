// Excel exports. The Projects and Milestones sheets use the old Execution
// Framework tracker's column names and values, so an exported workbook reads
// back through `npm run import` and opens in any pivot built on the tracker.
// Extra sheets (update log, plan, risks, weekly updates) are ignored by the import.
// This is a report for Excel, not a backup: importing it back covers projects shaped like
// the tracker's (milestones only). Use the Backup tab for a full copy.

import ExcelJS from 'exceljs';
import { db } from './db';
import { HttpError } from './auth';
import type { Health, TaskStatus } from '../shared/types';
import { CHANGE_SELECT, mapChange } from './changes';
import { todayIso } from '../shared/dates';
import { STALE_DAYS } from '../shared/health';

// ---- Tracker vocabulary (the reverse of import-tracker.ts) --------------------

const OVERALL_STATUS: Record<Health, string> = {
  done: 'Completed',
  not_started: 'Not Started',
  at_risk: 'At Risk',
  on_track: 'On Track',
  off_track: 'Delayed',
};
const MILESTONE_STATUS: Record<TaskStatus, string> = {
  done: 'Completed',
  todo: 'Not Started',
  in_progress: 'On Track',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};
const cap = (s: string | null | undefined) => (s ? s[0].toUpperCase() + s.slice(1) : null);

// ---- Sheet writing ---------------------------------------------------------------

type Kind = 'text' | 'date' | 'datetime' | 'int' | 'pct' | 'wrap';
interface Col {
  header: string;
  key: string;
  width?: number;
  kind?: Kind;
}

/** 'YYYY-MM-DD' as a real Excel date (UTC midnight), so sorting and filters work. */
const KUWAIT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** A moment as Kuwait wall-clock time written as UTC, so Excel shows the time people saw in the app. */
function kuwaitWall(d: Date): Date {
  const p = Object.fromEntries(KUWAIT.formatToParts(d).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}

function asDate(v: unknown, wall = false): Date | null {
  if (!v) return null;
  if (v instanceof Date) return wall ? kuwaitWall(v) : v;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addSheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, unknown>[]): void {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? (c.kind === 'date' ? 13 : c.kind === 'datetime' ? 18 : c.kind === 'int' || c.kind === 'pct' ? 11 : 20),
  }));
  for (const r of rows) {
    const out: Record<string, unknown> = {};
    for (const c of cols) {
      const v = r[c.key];
      out[c.key] = c.kind === 'datetime' ? asDate(v, true) : c.kind === 'date' ? asDate(v, v instanceof Date) : c.kind === 'int' || c.kind === 'pct' ? (v === null || v === undefined || v === '' ? null : Number(v)) : (v ?? null);
    }
    ws.addRow(out);
  }
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.kind === 'date') col.numFmt = 'yyyy-mm-dd';
    if (c.kind === 'datetime') col.numFmt = 'yyyy-mm-dd hh:mm';
    if (c.kind === 'wrap') col.alignment = { wrapText: true, vertical: 'top' };
  });
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14181D' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

export async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function newBook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SWiSH PMO';
  wb.created = new Date();
  return wb;
}

// ---- Shared queries ---------------------------------------------------------------

const PROJECT_COLS: Col[] = [
  { header: 'Project ID', key: 'code', width: 12 },
  { header: 'Initiative Name', key: 'name', width: 40, kind: 'wrap' },
  { header: 'Category', key: 'category', width: 22 },
  { header: 'Priority', key: 'priority', width: 10 },
  { header: 'Gate', key: 'gate', width: 12 },
  { header: 'Executive Sponsor', key: 'sponsor' },
  { header: 'Project Owner', key: 'owner' },
  { header: 'Start Date', key: 'start_date', kind: 'date' },
  { header: 'Target Date', key: 'end_date', kind: 'date' },
  // Not in the tracker: the project's baseline, so an exported file re-imports with its slips intact.
  { header: 'Original Start', key: 'baseline_start', kind: 'date' },
  { header: 'Original Target', key: 'baseline_end', kind: 'date' },
  { header: 'Success Metric', key: 'success_metric', width: 30, kind: 'wrap' },
  { header: 'Success Target', key: 'success_target', width: 30, kind: 'wrap' },
  { header: 'Total Milestones', key: 'total', kind: 'int' },
  { header: 'Completed Milestones', key: 'completed', kind: 'int' },
  { header: '% Complete', key: 'tracker_pct', kind: 'pct' },
  { header: 'Plan % Complete', key: 'progress', kind: 'pct' },
  { header: 'Open Risks', key: 'open_risks', kind: 'int' },
  { header: 'Overdue Milestones', key: 'overdue', kind: 'int' },
  { header: 'Stale Milestones', key: 'stale', kind: 'int' },
  { header: 'Overall Status', key: 'overall', width: 14 },
  { header: 'Stage', key: 'stage', width: 12 },
  { header: 'Quarter', key: 'quarter', width: 10 },
  { header: 'Last Milestone Update', key: 'last_update', kind: 'date' },
];

async function projectRows(ids: number[]): Promise<Record<string, unknown>[]> {
  if (!ids.length) return [];
  const today = todayIso();
  const { rows } = await db.query(
    `SELECT p.*, d.name AS category, u.name AS manager_name, q.code AS quarter,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone') AS total,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone' AND t.status = 'done') AS completed,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone' AND t.status <> 'cancelled') AS live_total,
        (SELECT COUNT(*) FROM risks r WHERE r.project_id = p.id AND r.status <> 'closed') AS open_risks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone'
            AND t.status NOT IN ('done','cancelled') AND t.end_date < CAST($2 AS DATE)) AS overdue,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone'
            AND t.status NOT IN ('done','cancelled')
            AND (t.last_update_on IS NULL OR t.last_update_on < DATEADD(DAY, -$3, CAST($2 AS DATE)))) AS stale,
        (SELECT MAX(t.last_update_on) FROM tasks t WHERE t.project_id = p.id) AS last_update
       FROM projects p
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN users u ON u.id = p.manager_id
       LEFT JOIN quarters q ON q.id = p.quarter_id
      WHERE p.id IN (SELECT value FROM OPENJSON($1))
      ORDER BY p.code`,
    [ids, today, STALE_DAYS],
  );
  return rows.map((r: any) => ({
    ...r,
    priority: cap(r.priority),
    owner: r.manager_name ?? r.owner_name,
    // The tracker's rule (done over non-cancelled milestones), which is what an import rebuilds. The app's own,
    // duration-weighted figure goes in 'Plan % Complete'.
    tracker_pct: r.live_total > 0 ? Math.round((100 * r.completed) / r.live_total) : r.progress,
    overall: OVERALL_STATUS[r.health as Health] ?? r.health,
    stage: cap(r.stage),
  }));
}

const MILESTONE_COLS: Col[] = [
  { header: 'Project ID', key: 'project_code', width: 12 },
  { header: 'Project Name', key: 'project_name', width: 32 },
  { header: 'Phase', key: 'phase', width: 22 },
  { header: 'Milestone ID', key: 'code_out', width: 13 },
  { header: 'Milestone Description', key: 'name', width: 50, kind: 'wrap' },
  { header: 'Responsible Department', key: 'responsible_dept' },
  { header: 'Responsible Owner', key: 'owner' },
  { header: 'Co-owners', key: 'co_owners' },
  { header: 'Escalate To', key: 'escalate_to' },
  { header: 'Original Deadline', key: 'baseline_end', kind: 'date' },
  { header: 'Current Deadline', key: 'end_date', kind: 'date' },
  // The tracker kept current and effective deadlines apart; here they are one date. Keys must be unique per sheet.
  { header: 'Effective Deadline', key: 'effective_date', kind: 'date' },
  { header: 'Slip (days)', key: 'slip', kind: 'int' },
  { header: 'Status', key: 'status_label', width: 13 },
  { header: '% Complete', key: 'progress', kind: 'pct' },
  { header: 'Health', key: 'health', width: 12 },
  { header: 'Last Update', key: 'last_update_on', kind: 'date' },
  { header: 'Update Comment', key: 'update_comment', width: 50, kind: 'wrap' },
  { header: 'Dependency / Blocker', key: 'blocker', width: 36, kind: 'wrap' },
  { header: 'Dependency Type', key: 'dependency_type', width: 14 },
  { header: 'Stream', key: 'stream' },
  { header: 'Completed At', key: 'completed_at', kind: 'date' },
];

/** Milestone rows (kind = milestone) in tracker form. */
async function milestoneRows(where: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const today = todayIso();
  const { rows } = await db.query(
    `SELECT t.*, p.code AS project_code, p.name AS project_name, ph.name AS phase, u.name AS assignee_name,
        (SELECT CAST(MIN(m.created_at) AT TIME ZONE 'Arab Standard Time' AS DATE) FROM milestone_updates m
          WHERE m.task_id = t.id AND m.status = 'done' AND m.author_id IS NOT NULL
            AND m.created_at > COALESCE((SELECT MAX(x.created_at) FROM milestone_updates x
                                          WHERE x.task_id = t.id AND x.status <> 'done'), CAST('0001-01-01' AS DATETIMEOFFSET(3)))) AS completed_at
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN tasks ph ON ph.id = t.parent_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.kind = 'milestone' AND ${where}
      ORDER BY p.code, t.sort, t.id`,
    params,
  );
  return rows.map((r: any) => {
    const open = r.status !== 'done' && r.status !== 'cancelled';
    const slip = r.baseline_end && r.end_date ? Math.round((Date.parse(r.end_date) - Date.parse(r.baseline_end)) / 86_400_000) : null;
    const stale = open && (!r.last_update_on || Date.parse(r.last_update_on) < Date.parse(today) - STALE_DAYS * 86_400_000);
    return {
      ...r,
      owner: r.owner_name ?? r.assignee_name,
      // Milestones made in the app have no tracker code: give them a stable one so a re-import can name them.
      code_out: r.code ?? `${r.project_code}-M${r.id}`,
      effective_date: r.end_date,
      status_label: MILESTONE_STATUS[r.status as TaskStatus] ?? r.status,
      slip,
      health: !open ? (r.status === 'done' ? 'Done' : 'Cancelled') : r.end_date < today ? 'Overdue' : r.status === 'blocked' ? 'Blocked' : stale ? 'Needs update' : 'On Track',
      completed_at: r.status === 'done' ? r.completed_at : null,
    };
  });
}

const LOG_COLS: Col[] = [
  { header: 'Project ID', key: 'project_code', width: 12 },
  { header: 'Milestone ID', key: 'code', width: 13 },
  { header: 'Milestone', key: 'name', width: 40 },
  { header: 'When', key: 'created_at', kind: 'datetime' },
  { header: 'By', key: 'author' },
  { header: 'Status', key: 'status_label', width: 13 },
  { header: '% Complete', key: 'progress', kind: 'pct' },
  { header: 'Comment', key: 'comment', width: 50, kind: 'wrap' },
  { header: 'Blocker', key: 'blocker', width: 36, kind: 'wrap' },
];

async function logRows(taskIds: number[]): Promise<Record<string, unknown>[]> {
  if (!taskIds.length) return [];
  const { rows } = await db.query(
    `SELECT m.*, t.code, t.name, p.code AS project_code, COALESCE(u.name, 'Tracker import') AS author
       FROM milestone_updates m
       JOIN tasks t ON t.id = m.task_id
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = m.author_id
      WHERE m.task_id IN (SELECT value FROM OPENJSON($1))
      ORDER BY p.code, t.sort, t.id, m.created_at DESC, m.id DESC`,
    [taskIds],
  );
  return rows.map((r: any) => ({
    ...r,
    code: r.code ?? `${r.project_code}-M${r.task_id}`,
    status_label: MILESTONE_STATUS[r.status as TaskStatus] ?? r.status,
  }));
}

// ---- The three exports -------------------------------------------------------------

/** The portfolio: Projects + Milestones in tracker form, plus the update log. */
export async function portfolioWorkbook(projectIds: number[]): Promise<ExcelJS.Workbook> {
  const wb = newBook();
  addSheet(wb, 'Projects', PROJECT_COLS, await projectRows(projectIds));
  const ms = projectIds.length ? await milestoneRows('t.project_id IN (SELECT value FROM OPENJSON($1))', [projectIds]) : [];
  addSheet(wb, 'Milestones', MILESTONE_COLS, ms);
  addSheet(wb, 'Update Log', LOG_COLS, await logRows(ms.map((m) => m.id as number)));
  return wb;
}

/** Chosen milestones (the Milestones page filter), with their update log. */
export async function milestonesWorkbook(taskIds: number[]): Promise<ExcelJS.Workbook> {
  const wb = newBook();
  const ms = taskIds.length ? await milestoneRows('t.id IN (SELECT value FROM OPENJSON($1))', [taskIds]) : [];
  addSheet(wb, 'Milestones', MILESTONE_COLS, ms);
  addSheet(wb, 'Update Log', LOG_COLS, await logRows(ms.map((m) => m.id as number)));
  return wb;
}

/** One project: its row, the whole plan (phases and tasks too), log, risks and weekly updates. */
export async function projectWorkbook(projectId: number): Promise<{ wb: ExcelJS.Workbook; code: string }> {
  const wb = newBook();
  const [proj] = await projectRows([projectId]);
  if (!proj) throw new HttpError(404, 'Project not found.');
  addSheet(wb, 'Projects', PROJECT_COLS, [proj]);
  const ms = await milestoneRows('t.project_id = $1', [projectId]);
  addSheet(wb, 'Milestones', MILESTONE_COLS, ms);

  // The plan as the Gantt shows it: WBS numbers, indentation by depth.
  const { rows: tasks } = await db.query(
    `SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = $1 ORDER BY t.sort, t.id`,
    [projectId],
  );
  const children = new Map<number | null, any[]>();
  for (const t of tasks) children.set(t.parent_id ?? null, [...(children.get(t.parent_id ?? null) ?? []), t]);
  const plan: Record<string, unknown>[] = [];
  const walk = (parent: number | null, prefix: string, depth: number) => {
    (children.get(parent) ?? []).forEach((t, i) => {
      const wbs = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      plan.push({
        wbs,
        kind: cap(t.kind === 'summary' ? 'phase' : t.kind),
        name: `${'    '.repeat(depth)}${t.name}`,
        code: t.code,
        start_date: t.start_date,
        end_date: t.end_date,
        baseline_start: t.baseline_start,
        baseline_end: t.baseline_end,
        slip: t.baseline_end ? Math.round((Date.parse(t.end_date) - Date.parse(t.baseline_end)) / 86_400_000) : null,
        progress: t.progress,
        status: MILESTONE_STATUS[t.status as TaskStatus] ?? t.status,
        owner: t.owner_name ?? t.assignee_name,
        responsible_dept: t.responsible_dept,
        blocker: t.blocker,
        last_update_on: t.last_update_on,
        update_comment: t.update_comment,
      });
      walk(t.id, wbs, depth + 1);
    });
  };
  walk(null, '', 0);
  addSheet(
    wb,
    'Plan',
    [
      { header: '#', key: 'wbs', width: 8 },
      { header: 'Type', key: 'kind', width: 11 },
      { header: 'Name', key: 'name', width: 55 },
      { header: 'Milestone ID', key: 'code', width: 13 },
      { header: 'Start', key: 'start_date', kind: 'date' },
      { header: 'Finish', key: 'end_date', kind: 'date' },
      { header: 'Baseline Start', key: 'baseline_start', kind: 'date' },
      { header: 'Baseline Finish', key: 'baseline_end', kind: 'date' },
      { header: 'Slip (days)', key: 'slip', kind: 'int' },
      { header: '% Complete', key: 'progress', kind: 'pct' },
      { header: 'Status', key: 'status', width: 13 },
      { header: 'Owner', key: 'owner' },
      { header: 'Responsible Department', key: 'responsible_dept' },
      { header: 'Blocker', key: 'blocker', width: 36, kind: 'wrap' },
      { header: 'Last Update', key: 'last_update_on', kind: 'date' },
      { header: 'Update Comment', key: 'update_comment', width: 50, kind: 'wrap' },
    ],
    plan,
  );
  addSheet(wb, 'Update Log', LOG_COLS, await logRows(tasks.map((t: any) => t.id)));

  // The change log, with the columns of the PMO's Change Log workbook.
  const { rows: crs } = await db.query(`${CHANGE_SELECT} WHERE c.project_id = $1 ORDER BY c.seq`, [projectId]);
  const STATUS: Record<string, string> = { pending: 'Pending', on_hold: 'On hold', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' };
  addSheet(
    wb,
    'Change Log',
    [
      { header: 'ID', key: 'code', width: 9 },
      { header: 'DATE', key: 'date', kind: 'date' },
      { header: 'REQUESTED BY', key: 'by', width: 18 },
      { header: 'CHANGE REQUEST DESCRIPTION', key: 'description', width: 45, kind: 'wrap' },
      { header: 'REASONS FOR THE CHANGE', key: 'reason', width: 40, kind: 'wrap' },
      { header: 'AREA', key: 'areas', width: 18 },
      { header: 'STATUS', key: 'status', width: 22 },
      { header: 'PROGRESS OF PENDING AND APPROVED CHANGES / REASON FOR REJECTION', key: 'progress', width: 45, kind: 'wrap' },
      { header: 'ACTIONS RELATED TO THE CHANGE / AREA OF IMPACT', key: 'actions', width: 45, kind: 'wrap' },
      { header: 'COMPLETION / Launch DATE', key: 'completion', kind: 'date' },
      { header: 'APPROVALS', key: 'approvals', width: 40, kind: 'wrap' },
      { header: 'NOTES', key: 'notes', width: 35, kind: 'wrap' },
    ],
    crs.map(mapChange).map((c) => ({
      code: c.code,
      date: c.requestedAt.slice(0, 10),
      by: c.requestedByName,
      description: c.description,
      reason: c.reason,
      areas: c.areas.map((x) => x[0].toUpperCase() + x.slice(1)).join(', '),
      status: c.status === 'pending' || c.status === 'on_hold' ? `${STATUS[c.status]} (${c.stage === 'head' ? 'department head' : 'PMO'})` : STATUS[c.status],
      progress: c.status === 'rejected' ? c.decisionNote : c.progress || (c.applied ?? []).join('; '),
      actions: [c.actions, c.actionsDate ? `(by ${c.actionsDate})` : ''].filter(Boolean).join(' '),
      completion: c.completionDate,
      approvals: [
        c.headSkipped ? `Head: ${c.headSkipped}` : c.headByName ? `Head: ${c.headByName} ${c.headAt?.slice(0, 10)}` : '',
        c.decidedByName ? `${c.status === 'rejected' ? 'Rejected' : 'PMO'}: ${c.decidedByName} ${c.decidedAt?.slice(0, 10)}` : '',
      ].filter(Boolean).join('\n'),
      notes: c.notes,
    })),
  );

  const { rows: risks } = await db.query(
    `SELECT r.*, u.name AS owner FROM risks r LEFT JOIN users u ON u.id = r.owner_id WHERE r.project_id = $1 ORDER BY r.status, r.id`,
    [projectId],
  );
  addSheet(
    wb,
    'Risks & Issues',
    [
      { header: 'Type', key: 'kind', width: 9 },
      { header: 'Title', key: 'title', width: 45, kind: 'wrap' },
      { header: 'Impact', key: 'impact', width: 10 },
      { header: 'Likelihood', key: 'likelihood', width: 11 },
      { header: 'Owner', key: 'owner' },
      { header: 'Due', key: 'due_date', kind: 'date' },
      { header: 'Status', key: 'status', width: 11 },
      { header: 'Response', key: 'mitigation', width: 50, kind: 'wrap' },
    ],
    risks.map((r: any) => ({ ...r, kind: cap(r.kind), impact: cap(r.impact), likelihood: cap(r.likelihood), status: cap(r.status) })),
  );

  const { rows: updates } = await db.query(
    `SELECT s.*, u.name AS author FROM status_updates s LEFT JOIN users u ON u.id = s.author_id WHERE s.project_id = $1 ORDER BY s.week_start DESC`,
    [projectId],
  );
  addSheet(
    wb,
    'Weekly Updates',
    [
      { header: 'Week of', key: 'week_start', kind: 'date' },
      { header: 'Health', key: 'health_label', width: 12 },
      { header: '% Complete', key: 'progress', kind: 'pct' },
      { header: 'Done this week', key: 'accomplishments', width: 45, kind: 'wrap' },
      { header: 'Next', key: 'next_steps', width: 45, kind: 'wrap' },
      { header: 'Blockers', key: 'blockers', width: 40, kind: 'wrap' },
      { header: 'Decisions needed', key: 'decisions', width: 40, kind: 'wrap' },
      { header: 'By', key: 'author' },
      { header: 'Filed', key: 'submitted_at', kind: 'datetime' },
    ],
    updates.map((u: any) => ({ ...u, health_label: OVERALL_STATUS[u.health as Health] ?? u.health })),
  );
  return { wb, code: proj.code as string };
}
