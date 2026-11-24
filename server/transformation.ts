import fs from 'node:fs';
import path from 'node:path';
import type ExcelJS from 'exceljs';
import type { Queryable } from './db';
import { db } from './db';
import { HttpError } from './auth';
import type { Capability, PlanLink } from '../shared/types';

// The transformation plan: the PMO's "SWiSH Transformation Capabilities" workbook (sheet Projects). Its rows are
// Capability > Dimension > plan project, with the plan's own columns (owner, outcome, KPI, target...). The plan is
// imported from the workbook (first from server/seeds, later from an upload) and the workbook stays its source.
// Projects of the system hang under a plan project (projects.initiative_id), which only the PMO chooses: nothing is linked
// automatically.

export interface PlanRow {
  capability: string;
  dimension: string;
  name: string;
  type?: string;
  status?: string;
  priority?: string;
  owner?: string;
  outcome?: string;
  completionCriteria?: string;
  outcomeKpi?: string;
  baseline?: string;
  target?: string;
  startDate?: string;
  targetCompletion?: string;
  parentInitiative?: string;
  dependency?: string;
}

const COLUMNS: [keyof PlanRow, string][] = [
  ['type', 'type'],
  ['status', 'status'],
  ['priority', 'priority'],
  ['owner', 'owner'],
  ['outcome', 'outcome'],
  ['completionCriteria', 'completion_criteria'],
  ['outcomeKpi', 'outcome_kpi'],
  ['baseline', 'baseline'],
  ['target', 'target'],
  ['startDate', 'start_date'],
  ['targetCompletion', 'target_completion'],
  ['parentInitiative', 'parent_initiative'],
  ['dependency', 'dependency'],
];

const seedFile = (name: string) => {
  const here = path.resolve(__dirname, 'seeds', name);
  return fs.existsSync(here) ? here : path.resolve(__dirname, '..', '..', 'server', 'seeds', name);
};

/**
 * Adds the workbook's rows to the plan: new capabilities, dimensions and plan projects are created, existing ones
 * (same names) take the workbook's values. Nothing is deleted: a plan project dropped from the workbook stays, so no
 * link to it is lost, and is counted. Order follows the workbook.
 */
export async function importPlan(q: Queryable, rows: PlanRow[]): Promise<{ capabilities: number; dimensions: number; projects: number; added: number; notInWorkbook: number }> {
  const caps = new Map<string, number>();
  const dims = new Map<string, number>();
  const seen = new Set<number>();
  let added = 0;
  let order = 0;
  for (const r of rows) {
    order += 1;
    const capName = r.capability.trim();
    const dimName = r.dimension.trim();
    const name = r.name.trim();
    if (!capName || !dimName || !name) continue;
    let capId = caps.get(capName);
    if (!capId) {
      const { rows: c } = await q.query(
        `DECLARE @r TABLE (id INT);
         UPDATE capabilities WITH (HOLDLOCK) SET sort = $2 OUTPUT INSERTED.id INTO @r WHERE name = $1;
         IF NOT EXISTS (SELECT 1 FROM @r) INSERT INTO capabilities (name, sort) OUTPUT INSERTED.id INTO @r VALUES ($1, $2);
         SELECT id FROM @r;`,
        [capName, caps.size + 1],
      );
      capId = c[0].id as number;
      caps.set(capName, capId);
    }
    const dimKey = `${capId}|${dimName}`;
    let dimId = dims.get(dimKey);
    if (!dimId) {
      const { rows: d } = await q.query(
        `DECLARE @r TABLE (id INT);
         UPDATE dimensions WITH (HOLDLOCK) SET sort = $3 OUTPUT INSERTED.id INTO @r WHERE capability_id = $1 AND name = $2;
         IF NOT EXISTS (SELECT 1 FROM @r) INSERT INTO dimensions (capability_id, name, sort) OUTPUT INSERTED.id INTO @r VALUES ($1, $2, $3);
         SELECT id FROM @r;`,
        [capId, dimName, dims.size + 1],
      );
      dimId = d[0].id as number;
      dims.set(dimKey, dimId);
    }
    const vals = COLUMNS.map(([k]) => (String(r[k] ?? '').trim() || null));
    const { rows: i } = await q.query(
      `DECLARE @r TABLE (id INT, inserted BIT);
       UPDATE initiatives WITH (HOLDLOCK) SET sort = $3, ${COLUMNS.map(([, c], n) => `${c} = $${n + 4}`).join(', ')}
         OUTPUT INSERTED.id, 0 INTO @r WHERE dimension_id = $1 AND name = $2;
       IF NOT EXISTS (SELECT 1 FROM @r)
         INSERT INTO initiatives (dimension_id, name, sort, ${COLUMNS.map(([, c]) => c).join(', ')})
         OUTPUT INSERTED.id, 1 INTO @r
         VALUES ($1, $2, $3, ${COLUMNS.map((_, n) => `$${n + 4}`).join(', ')});
       SELECT id, inserted FROM @r;`,
      [dimId, name, order, ...vals],
    );
    seen.add(i[0].id);
    if (i[0].inserted) added += 1;
  }
  const { rows: all } = await q.query('SELECT id FROM initiatives');
  return { capabilities: caps.size, dimensions: dims.size, projects: seen.size, added, notInWorkbook: all.filter((x) => !seen.has(x.id)).length };
}

/**
 * Places the projects that are not linked yet under the plan project they deliver, from the list prepared for the
 * projects of the tracker (server/seeds/plan-links.json, by project code). It runs once (a flag in schema_flags): the
 * PMO's later changes, and links it removes, stay as the PMO left them. Projects not in the list stay unlinked.
 */
export async function applyPlanLinks(): Promise<void> {
  const file = seedFile('plan-links.json');
  if (!fs.existsSync(file)) return;
  const { rows: cap } = await db.query('SELECT COUNT(*) AS n FROM initiatives');
  if (cap[0].n === 0) return;
  const { rows: flag } = await db.query(
    "INSERT INTO schema_flags (name) OUTPUT INSERTED.name SELECT 'plan-links-1' WHERE NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = 'plan-links-1')",
  );
  if (!flag.length) return;
  const links = JSON.parse(fs.readFileSync(file, 'utf8')).links as Record<string, { initiative: string }>;
  const { rows: inits } = await db.query('SELECT id, name FROM initiatives');
  const byName = new Map(inits.map((x) => [x.name as string, x.id as number]));
  let n = 0;
  for (const [code, l] of Object.entries(links)) {
    const id = byName.get(l.initiative);
    if (!id) continue;
    const { rowCount } = await db.query('UPDATE projects SET initiative_id = $2 WHERE code = $1 AND initiative_id IS NULL', [code, id]);
    n += rowCount;
  }
  if (n) console.log(`[seed] Transformation plan: ${n} projects placed under their plan project.`);
}

/** The first time (no capability yet), the plan comes from the workbook kept in server/seeds. */
export async function seedPlan(): Promise<void> {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM capabilities');
  if (rows[0].n > 0) return;
  const file = seedFile('transformation-plan.json');
  if (!fs.existsSync(file)) return;
  const { rows: planRows } = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: PlanRow[] };
  const r = await db.tx((q) => importPlan(q, planRows));
  console.log(`[seed] Transformation plan: ${r.capabilities} capabilities, ${r.dimensions} dimensions, ${r.projects} plan projects.`);
}

/** The plan as a tree, each plan project with the ids of its linked projects among `visible` (null: all). */
export async function loadPlan(visible: Set<number> | null): Promise<Capability[]> {
  const [c, d, i, p] = await Promise.all([
    db.query('SELECT * FROM capabilities ORDER BY sort, id'),
    db.query('SELECT * FROM dimensions ORDER BY sort, id'),
    db.query('SELECT * FROM initiatives ORDER BY sort, id'),
    db.query('SELECT id, initiative_id FROM projects WHERE initiative_id IS NOT NULL AND archived = 0 ORDER BY code'),
  ]);
  const byInitiative = new Map<number, number[]>();
  for (const r of p.rows) {
    if (visible && !visible.has(r.id)) continue;
    byInitiative.set(r.initiative_id, [...(byInitiative.get(r.initiative_id) ?? []), r.id]);
  }
  return c.rows.map((cap) => ({
    id: cap.id,
    name: cap.name,
    managerUserId: cap.manager_user_id ?? null,
    dimensions: d.rows
      .filter((x) => x.capability_id === cap.id)
      .map((dim) => ({
        id: dim.id,
        capabilityId: cap.id,
        name: dim.name,
        managerUserId: dim.manager_user_id ?? null,
        initiatives: i.rows
          .filter((x) => x.dimension_id === dim.id)
          .map((x) => ({
            id: x.id,
            dimensionId: dim.id,
            name: x.name,
            type: x.type,
            status: x.status,
            priority: x.priority,
            owner: x.owner,
            outcome: x.outcome,
            completionCriteria: x.completion_criteria,
            outcomeKpi: x.outcome_kpi,
            baseline: x.baseline,
            target: x.target,
            startDate: x.start_date,
            targetCompletion: x.target_completion,
            parentInitiative: x.parent_initiative,
            dependency: x.dependency,
            projectIds: byInitiative.get(x.id) ?? [],
          })),
      })),
  }));
}

/** Every project with the plan project it is linked to now (none until the PMO links it). */
export async function planLinks(): Promise<PlanLink[]> {
  const { rows } = await db.query('SELECT id, code, name, department_id, initiative_id FROM projects WHERE archived = 0 ORDER BY code');
  return rows.map((p) => ({ projectId: p.id, code: p.code, name: p.name, departmentId: p.department_id, initiativeId: p.initiative_id ?? null }));
}

/** The rows of an uploaded workbook: the sheet "Projects" (or the first), from its header row "Capability". */
export async function readPlanWorkbook(buf: Buffer): Promise<PlanRow[]> {
  const ExcelJSmod = (await import('exceljs')).default as unknown as typeof ExcelJS;
  const wb = new ExcelJSmod.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, 'This is not an Excel workbook (.xlsx).');
  }
  const ws = wb.getWorksheet('Projects') ?? wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'The workbook has no sheet.');
  const text = (v: unknown): string => {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      const o = v as { richText?: { text: string }[]; text?: string; result?: unknown };
      return o.richText ? o.richText.map((r) => r.text).join('') : String(o.text ?? o.result ?? '');
    }
    return String(v);
  };
  let head = 0;
  ws.eachRow((r, n) => {
    if (!head && text(r.getCell(1).value).trim().toLowerCase() === 'capability') head = n;
  });
  if (!head) throw new HttpError(400, 'No header row starting with "Capability" was found (the Projects sheet of the Transformation Capabilities workbook).');
  const keys: (keyof PlanRow)[] = ['capability', 'dimension', 'name', 'type', 'status', 'priority', 'owner', 'outcome', 'completionCriteria', 'outcomeKpi', 'baseline', 'target', 'startDate', 'targetCompletion', 'parentInitiative', 'dependency'];
  const rows: PlanRow[] = [];
  ws.eachRow((r, n) => {
    if (n <= head) return;
    const o = {} as Record<string, string>;
    keys.forEach((k, i) => (o[k] = text(r.getCell(i + 1).value).replace(/\s+/g, ' ').trim()));
    if (o.capability && o.dimension && o.name) rows.push(o as unknown as PlanRow);
  });
  if (!rows.length) throw new HttpError(400, 'The sheet has no rows with a capability, a dimension and a project.');
  return rows;
}
