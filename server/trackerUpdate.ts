import fs from 'node:fs';
import path from 'node:path';
import type ExcelJS from 'exceljs';
import type { Queryable } from './db';
import { HttpError } from './auth';
import { cleanName, linkPeople, norm } from './people';
import { resync } from './service';
import { addDays, todayIso } from '../shared/dates';
import type { Health, TaskStatus } from '../shared/types';

// The Milestones Tracker (New Execution Framework): one sheet, one row per milestone. It brings the week's news from
// the people who run the projects. Applying it:
//  - for the projects already in the system: the status, % complete, last update comment and blocker of the milestones
//    that changed. Dates, owners, names and the plan are never touched (after a baseline they change only by a change
//    request);
//  - for the projects the system does not have yet: the project is created with its phases and milestones.
// Milestones that the file has and the system does not, for a project that exists, are only listed.
//
// The file may arrive with its month names lost ("29-?????-26": Excel in Arabic saved them as text). The "Days to
// Deadline" column survives, so a deadline is the day the file was calculated (found from the rows that still have a
// real date) plus those days. Dates are only needed for new projects.

export interface TrackerRow {
  project: string;
  projectName: string;
  phase: string | null;
  code: string;
  description: string;
  department: string | null;
  owner: string | null;
  escalateTo: string | null;
  original: string | null;
  current: string | null;
  days: number | null;
  /** The day, when the month was lost: 29 for "29-?????-26". */
  originalDay: number | null;
  status: string | null;
  progress: number | null;
  lastUpdate: string | null;
  comment: string | null;
  blocker: string | null;
}

const STATUS: Record<string, TaskStatus> = {
  completed: 'done',
  'on track': 'in_progress',
  'not started': 'todo',
  cancelled: 'cancelled',
  'on hold': 'blocked',
  blocked: 'blocked',
};

/** DF2-01 and DF2-1 are the same milestone: the number loses its leading zeros. */
const normCode = (c: unknown): string => String(c ?? '').trim().toUpperCase().replace(/-0+(\d)/, '-$1');

/** The same words however they are spaced or capitalised. */
const sameText = (a: unknown, b: unknown): boolean => norm(String(a ?? '')) === norm(String(b ?? ''));

const textOf = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; text?: unknown; result?: unknown };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    return String(o.result ?? o.text ?? '');
  }
  return String(v);
};
const clean = (v: unknown): string | null => {
  const s = textOf(v).replace(/\r\n?/g, '\n').trim();
  return s === '' ? null : s;
};

/** A real date from a cell: a date, an Excel serial, 2026-10-27 or 27/10/2026. Null when the month was lost. */
function realDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(0, 10);
  const s = textOf(v).trim();
  if (!s || s.includes('?')) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{5}$/.test(s)) return realDate(Number(s));
  return null;
}

/** The day of the month of "29-?????-26", when only the month was lost. */
function lostDay(v: unknown): number | null {
  const m = textOf(v).trim().match(/^(\d{1,2})-\?+-\d{2,4}$/);
  return m ? Number(m[1]) : null;
}

/** The percentage as 0-100: the tracker keeps 0.6 for 60%. */
function percent(v: unknown): number | null {
  const s = textOf(v).replace('%', '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const p = typeof v === 'string' && textOf(v).includes('%') ? n : n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(p)));
}

export async function readTracker(buf: Buffer): Promise<{ rows: TrackerRow[]; base: string; baseFrom: 'file' | 'today' }> {
  const ExcelJSmod = (await import('exceljs')).default as unknown as typeof ExcelJS;
  const wb = new ExcelJSmod.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, 'This is not an Excel workbook (.xlsx).');
  }
  const ws = wb.worksheets.find((w) => w.name.toLowerCase() === 'in') ?? wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'The workbook has no sheet.');
  let head = 0;
  ws.eachRow((r, n) => {
    if (!head && textOf(r.getCell(1).value).trim().toLowerCase() === 'project id') head = n;
  });
  if (!head) throw new HttpError(400, 'No header row starting with "Project ID" was found: this is not the Milestones Tracker.');
  const col = new Map<string, number>();
  ws.getRow(head).eachCell((c, i) => col.set(textOf(c.value).trim().toLowerCase(), i));
  const need = ['project id', 'milestone id', 'status'];
  for (const k of need) if (!col.has(k)) throw new HttpError(400, `The column "${k}" is missing: this is not the Milestones Tracker.`);
  const at = (r: ExcelJS.Row, name: string) => (col.has(name) ? r.getCell(col.get(name)!).value : null);

  const rows: TrackerRow[] = [];
  ws.eachRow((r, n) => {
    if (n <= head) return;
    const project = clean(at(r, 'project id'));
    const code = clean(at(r, 'milestone id'));
    if (!project || !code) return;
    const days = Number(textOf(at(r, 'days to deadline')).trim());
    rows.push({
      project,
      projectName: (clean(at(r, 'project name')) ?? project).replace(/\s+/g, ' '),
      phase: clean(at(r, 'phase')),
      code,
      description: (clean(at(r, 'milestone description')) ?? code).replace(/\s+/g, ' '),
      department: clean(at(r, 'responsible department')),
      owner: clean(at(r, 'responsible owner')),
      escalateTo: clean(at(r, 'escalate to')),
      original: realDate(at(r, 'original deadline')),
      current: realDate(at(r, 'current deadline')),
      days: textOf(at(r, 'days to deadline')).trim() !== '' && Number.isFinite(days) ? days : null,
      originalDay: lostDay(at(r, 'original deadline')),
      status: clean(at(r, 'status')),
      progress: percent(at(r, '% complete')),
      lastUpdate: realDate(at(r, 'last update')),
      comment: clean(at(r, 'update comment')),
      blocker: clean(at(r, 'dependency / blocker')),
    });
  });
  if (!rows.length) throw new HttpError(400, 'The sheet has no milestone rows.');

  // The day the file was calculated: a real deadline minus its "Days to Deadline", the one most rows agree on.
  const votes = new Map<string, number>();
  for (const r of rows) {
    const d = r.current ?? r.original;
    if (d && r.days !== null) {
      const b = addDays(d, -r.days);
      votes.set(b, (votes.get(b) ?? 0) + 1);
    }
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? { rows, base: best[0], baseFrom: 'file' } : { rows, base: todayIso(), baseFrom: 'today' };
}

/** The deadline of a row, and whether it is a guess (the month was lost and no "days" survived). */
function deadlineOf(r: TrackerRow, base: string): { date: string; guessed: boolean } | null {
  if (r.current) return { date: r.current, guessed: false };
  if (r.days !== null) return { date: addDays(base, r.days), guessed: false };
  if (r.original) return { date: r.original, guessed: false };
  if (r.originalDay) {
    // The next day of the month with that number, counting from the day the file was calculated.
    for (let i = 0; i < 62; i++) {
      const d = addDays(base, i);
      if (Number(d.slice(8, 10)) === r.originalDay) return { date: d, guessed: true };
    }
  }
  return null;
}

export interface MilestoneChange {
  code: string;
  name: string;
  from: { status: string; progress: number; comment: string | null; blocker: string | null };
  to: { status: string; progress: number; comment: string | null; blocker: string | null };
}

export interface TrackerPlan {
  base: string;
  baseFrom: 'file' | 'today';
  rows: number;
  /** Projects already in the system: the milestones whose status, % complete, comment or blocker changed. */
  updated: { code: string; name: string; changes: MilestoneChange[]; unchanged: number }[];
  /** Projects the system does not have: created with their phases and milestones. */
  created: { code: string; name: string; department: string; milestones: number; start: string; end: string; plan: string | null; guessed: { code: string; date: string }[] }[];
  /** Projects that exist with no milestone at all: they get the file's milestones. */
  filled: { code: string; name: string; milestones: number; guessed: { code: string; date: string }[] }[];
  /** In the file, not in the system, for a project that exists and has milestones: not added. */
  extra: { project: string; codes: string[] }[];
  /** In the system, not in the file: untouched. */
  missing: number;
  /** Rows with no status: left as they are. */
  blankStatus: number;
  /** Rows whose milestone ID is used by several rows of the file and could not be told apart from the system's: left as they are. */
  duplicates: number;
}

const planLinkFile = () => {
  const here = path.resolve(__dirname, 'seeds', 'plan-links.json');
  return fs.existsSync(here) ? here : path.resolve(__dirname, '..', '..', 'server', 'seeds', 'plan-links.json');
};

function healthOf(statuses: (TaskStatus | null)[]): Health {
  const s = statuses.filter(Boolean) as TaskStatus[];
  if (s.length && s.every((x) => x === 'done' || x === 'cancelled')) return 'done';
  return s.some((x) => x === 'in_progress' || x === 'done') ? 'on_track' : 'not_started';
}

type Dated = { r: TrackerRow; date: string };

/**
 * Puts the milestones in a project: the phases in the order they begin, each milestone inside its phase (a milestone with
 * no phase stays at the top). Dates are also the baseline, as the tracker import does it.
 */
async function addMilestones(q: Queryable, projectId: number, dated: Dated[], firstSort: number): Promise<void> {
  const phases = new Map<string, Dated[]>();
  for (const x of dated) phases.set(x.r.phase ?? '', [...(phases.get(x.r.phase ?? '') ?? []), x]);
  const order = [...phases].sort((a, b) => a[1].map((x) => x.date).sort()[0].localeCompare(b[1].map((x) => x.date).sort()[0]));
  let sort = firstSort;
  const used = new Map<string, number>();
  for (const [phase, items] of order) {
    items.sort((a, b) => a.date.localeCompare(b.date) || a.r.code.localeCompare(b.r.code, undefined, { numeric: true }));
    let parentId: number | null = null;
    if (phase) {
      const { rows: ph } = await q.query(`INSERT INTO tasks (project_id, kind, name, start_date, end_date, sort) OUTPUT INSERTED.id VALUES ($1, 'summary', $2, $3, $3, $4)`, [projectId, phase, items[0].date, (sort += 10)]);
      parentId = ph[0].id;
    }
    for (const { r, date } of items) {
      // The ID is unique inside a project: a repeated one gets ~2, ~3...
      const n = (used.get(normCode(r.code)) ?? 0) + 1;
      used.set(normCode(r.code), n);
      const code = n === 1 ? r.code : `${r.code}~${n}`;
      const status = (r.status && STATUS[r.status.toLowerCase()]) || 'todo';
      const progress = status === 'done' ? 100 : r.progress ?? 0;
      await q.query(
        `INSERT INTO tasks (project_id, parent_id, kind, code, name, start_date, end_date, baseline_start, baseline_end, progress, status, sort,
            owner_name, responsible_dept, escalate_to, blocker, last_update_on, update_comment, update_comment_on)
         VALUES ($1,$2,'milestone',$3,$4,$5,$5,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $14 IS NOT NULL THEN CAST($13 AS DATE) END)`,
        [projectId, parentId, code, r.description, date, progress, status, (sort += 10), cleanName(r.owner), r.department, cleanName(r.escalateTo), r.blocker, r.lastUpdate, r.comment],
      );
    }
  }
}

/** The rows with a date each; those whose date had to be guessed are listed. */
function dateRows(list: TrackerRow[], base: string, fallback: string): { dated: Dated[]; guessed: { code: string; date: string }[] } {
  const guessed: { code: string; date: string }[] = [];
  const dated = list.map((r) => {
    const d = deadlineOf(r, base);
    if (!d || d.guessed) guessed.push({ code: r.code, date: d?.date ?? fallback });
    return { r, date: d?.date ?? fallback };
  });
  return { dated, guessed };
}

/**
 * Works out what the file would change; with apply=true it writes it, inside the caller's transaction, and the result
 * is the same plan. Nothing is deleted.
 */
export async function runTracker(q: Queryable, parsed: { rows: TrackerRow[]; base: string; baseFrom: 'file' | 'today' }, apply: boolean, userId: number | null): Promise<TrackerPlan> {
  const { rows, base, baseFrom } = parsed;
  const plan: TrackerPlan = { base, baseFrom, rows: rows.length, updated: [], created: [], filled: [], extra: [], missing: 0, blankStatus: 0, duplicates: 0 };
  const byProject = new Map<string, TrackerRow[]>();
  for (const r of rows) byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);

  const { rows: sysProjects } = await q.query('SELECT id, code, name FROM projects');
  const sys = new Map(sysProjects.map((p) => [String(p.code), p]));
  const { rows: depts } = await q.query('SELECT id, name FROM departments');
  const deptByName = new Map(depts.map((d) => [norm(d.name as string), d.id as number]));
  const { rows: inits } = await q.query('SELECT id, name FROM initiatives');
  const initByName = new Map(inits.map((i) => [i.name as string, i.id as number]));
  const links: Record<string, { initiative: string }> = fs.existsSync(planLinkFile()) ? JSON.parse(fs.readFileSync(planLinkFile(), 'utf8')).links : {};

  for (const [code, list] of byProject) {
    const p = sys.get(code);
    if (p) {
      const { rows: tasks } = await q.query(`SELECT id, code, name, status, progress, update_comment, blocker FROM tasks WHERE project_id = $1 AND kind = 'milestone' AND code IS NOT NULL`, [p.id]);
      const byCode = new Map(tasks.map((t) => [normCode(t.code), t]));
      if (tasks.length === 0) {
        const { rows: pe } = await q.query('SELECT end_date FROM projects WHERE id = $1', [p.id]);
        const { dated, guessed } = dateRows(list, base, String(pe[0].end_date));
        plan.filled.push({ code, name: String(p.name), milestones: list.length, guessed });
        if (apply) {
          await addMilestones(q, p.id, dated, 0);
          await resync(q, p.id);
          await q.query(`INSERT INTO activity (project_id, user_id, action, detail) VALUES ($1, $2, 'tracker.milestones_added', $3)`, [p.id, userId, JSON.stringify({ milestones: list.length, base })]);
        }
        continue;
      }
      const entry = { code, name: String(p.name), changes: [] as MilestoneChange[], unchanged: 0 };
      const extra: string[] = [];
      // A milestone ID used by several rows (the tracker repeats one per brand): a row counts only when its description is the
      // system milestone's own, the others are left alone and counted.
      const uses = new Map<string, number>();
      for (const r of list) uses.set(normCode(r.code), (uses.get(normCode(r.code)) ?? 0) + 1);
      for (const r of list) {
        const t = byCode.get(normCode(r.code));
        if (!t) {
          extra.push(r.code);
          continue;
        }
        if ((uses.get(normCode(r.code)) ?? 1) > 1 && !sameText(t.name, r.description)) {
          plan.duplicates += 1;
          continue;
        }
        const status = r.status ? STATUS[r.status.toLowerCase()] : undefined;
        if (!status) {
          plan.blankStatus += 1;
          entry.unchanged += 1;
          continue;
        }
        const progress = status === 'done' ? 100 : r.progress ?? (status === 'todo' ? 0 : Number(t.progress));
        const comment = r.comment ?? (t.update_comment as string | null);
        const blocker = r.blocker ?? (t.blocker as string | null);
        const same = status === t.status && progress === Number(t.progress) && (comment ?? null) === (t.update_comment ?? null) && (blocker ?? null) === (t.blocker ?? null);
        if (same) {
          entry.unchanged += 1;
          continue;
        }
        entry.changes.push({
          code: r.code,
          name: String(t.name),
          from: { status: t.status, progress: Number(t.progress), comment: t.update_comment ?? null, blocker: t.blocker ?? null },
          to: { status, progress, comment, blocker },
        });
        if (apply) {
          const on = r.lastUpdate ?? base;
          await q.query(
            `UPDATE tasks SET status = $2, progress = $3, update_comment = $4, blocker = $5, last_update_on = $6,
                    update_comment_on = CASE WHEN ($4 <> update_comment OR ($4 IS NULL AND update_comment IS NOT NULL) OR ($4 IS NOT NULL AND update_comment IS NULL)) THEN CAST($6 AS DATE) ELSE update_comment_on END
              WHERE id = $1`,
            [t.id, status, progress, comment, blocker, on],
          );
          await q.query(`INSERT INTO milestone_updates (task_id, author_id, status, progress, comment, blocker) VALUES ($1, NULL, $2, $3, $4, $5)`, [t.id, status, progress, comment, blocker]);
        }
      }
      plan.missing += tasks.filter((t) => !list.some((r) => normCode(r.code) === normCode(t.code))).length;
      if (extra.length) plan.extra.push({ project: code, codes: extra });
      if (entry.changes.length) {
        plan.updated.push(entry);
        if (apply) {
          await resync(q, p.id);
          await q.query(`INSERT INTO activity (project_id, user_id, action, detail) VALUES ($1, $2, 'tracker.updated', $3)`, [p.id, userId, JSON.stringify({ milestones: entry.changes.length, base })]);
        }
      }
      continue;
    }

    // A project the system does not have: it is created, as the tracker import creates one.
    const { dated, guessed } = dateRows(list, base, addDays(base, 30));
    const dates = dated.map((x) => x.date).sort();
    const start = dates[0];
    const end = dates[dates.length - 1];
    const tally = new Map<string, number>();
    for (const r of list) if (r.department) tally.set(r.department, (tally.get(r.department) ?? 0) + 1);
    const top = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const deptId = (top && deptByName.get(norm(top))) || deptByName.get(norm('Unassigned')) || [...deptByName.values()][0];
    const deptName = depts.find((d) => d.id === deptId)?.name ?? 'Unassigned';
    const statuses = list.map((r) => (r.status ? STATUS[r.status.toLowerCase()] ?? null : null));
    const initName = links[code]?.initiative;
    plan.created.push({ code, name: list[0].projectName, department: String(deptName), milestones: list.length, start, end, plan: initName ?? null, guessed });
    if (!apply) continue;

    const health = healthOf(statuses);
    const stage = health === 'done' ? 'closed' : health === 'not_started' ? 'planning' : 'execution';
    const { rows: pr } = await q.query(
      `INSERT INTO projects (code, name, department_id, priority, stage, health, start_date, end_date, baseline_start, baseline_end, progress, created_by, initiative_id)
       OUTPUT INSERTED.id VALUES ($1,$2,$3,'medium',$4,$5,$6,$7,$6,$7,0,$8,$9)`,
      [code, list[0].projectName, deptId, stage, health, start, end, userId, (initName && initByName.get(initName)) || null],
    );
    const projectId: number = pr[0].id;
    await addMilestones(q, projectId, dated, 0);
    await resync(q, projectId);
    await q.query(`INSERT INTO activity (project_id, user_id, action, detail) VALUES ($1, $2, 'project.imported', $3)`, [projectId, userId, JSON.stringify({ code, milestones: list.length, source: 'Milestones Tracker' })]);
  }
  if (apply && plan.created.length) await linkPeople(q);
  return plan;
}


