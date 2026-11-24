// Imports the Execution Framework tracker export (Projects + Milestones sheets).
//
//   npm run import -- data/source/execution-framework-all-2026-10-13.xlsx
//   npm run import -- <file> --update     replace projects that already exist
//
// Reads the file only. Never touches the tracker it came from. Everything runs
// in one transaction, then the result is checked against counts taken straight
// from the spreadsheet, so a silently dropped row fails the run.

import './env';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { db, initDb } from './db';
import { seedReference } from './seed';
import { resync } from './service';
import { cleanName, linkPeople, NAME_ALIASES, norm } from './people';
import { addDays } from '../shared/dates';
import { STAGES } from '../shared/types';
import type { Health, Priority, Stage, TaskStatus } from '../shared/types';

type Row = Record<string, unknown>;

function cell(v: unknown): unknown {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    return o.text ?? o.result ?? null;
  }
  return v ?? null;
}

function text(v: unknown): string | null {
  const s = String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  return s === '' ? null : s;
}

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = text(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function readSheet(wb: ExcelJS.Workbook, name: string): Row[] {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`The workbook has no "${name}" sheet.`);
  const head = (ws.getRow(1).values as unknown[]).slice(1).map((h) => String(cell(h) ?? '').trim());
  const rows: Row[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const o: Row = {};
    (row.values as unknown[]).slice(1).forEach((v, i) => {
      if (head[i]) o[head[i]] = cell(v);
    });
    if (Object.values(o).some((v) => v !== null && v !== '')) rows.push(o);
  });
  return rows;
}

const HEALTH: Record<string, Health> = {
  completed: 'done',
  'not started': 'not_started',
  'at risk': 'at_risk',
  'on track': 'on_track',
  delayed: 'off_track',
};
const TASK_STATUS: Record<string, TaskStatus> = {
  completed: 'done',
  'not started': 'todo',
  'on track': 'in_progress',
  cancelled: 'cancelled',
  blocked: 'blocked',
};
const PRIORITY: Record<string, Priority> = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };

/** Alias fix for a list such as "Ravi, Rajab": each name on its own. */
function cleanList(raw: unknown): string | null {
  const s = text(raw);
  if (!s) return null;
  return s
    .split(/\s*,\s*/)
    .map((p) => cleanName(p))
    .filter(Boolean)
    .join(', ');
}

function slug(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'DEPT';
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: npm run import -- <tracker.xlsx> [--update]');
    process.exit(2);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const P = readSheet(wb, 'Projects');
  const M = readSheet(wb, 'Milestones');
  console.log(`Read ${P.length} projects and ${M.length} milestones from ${path.basename(file)}`);

  await initDb();
  await seedReference();

  const report = {
    file: path.basename(file),
    importedAt: new Date().toISOString(),
    projects: { inserted: 0, replaced: 0, skipped: [] as string[] },
    milestones: 0,
    dateFallbacks: [] as { code: string; usedDate: string; from: string }[],
    aliasesApplied: {} as Record<string, number>,
    blockerIssues: 0,
    newDepartments: [] as string[],
    people: [] as string[],
  };
  const people = new Set<string>();
  const countAlias = (raw: unknown) => {
    for (const part of String(raw ?? '').split(/\s*,\s*/)) {
      const k = norm(part);
      if (NAME_ALIASES[k]) report.aliasesApplied[`${part.trim()} -> ${NAME_ALIASES[k]}`] = (report.aliasesApplied[`${part.trim()} -> ${NAME_ALIASES[k]}`] ?? 0) + 1;
    }
  };

  await db.tx(async (q) => {
    const deptRows = (await q.query('SELECT id, name FROM departments')).rows as { id: number; name: string }[];
    const depts = new Map(deptRows.map((d) => [norm(d.name), d.id]));
    const owner = (await q.query(`SELECT TOP (1) id FROM users WHERE role_id = 'admin' ORDER BY id`)).rows[0]?.id ?? null;
    const deptFor = async (category: string | null): Promise<number> => {
      const name = category ?? 'Unassigned';
      const hit = depts.get(norm(name));
      if (hit) return hit;
      const n = depts.size;
      const { rows } = await q.query(
        'INSERT INTO departments (code, name, name_ar, color_slot) OUTPUT INSERTED.id VALUES ($1, $2, $2, $3)',
        [`${slug(name)}${n}`, name, (n % 8) + 1],
      );
      depts.set(norm(name), rows[0].id);
      report.newDepartments.push(name);
      return rows[0].id;
    };

    for (const p of P) {
      const code = text(p['Project ID'])!;
      const existing = (await q.query('SELECT id FROM projects WHERE code = $1', [code])).rows[0];
      if (existing && !update) {
        report.projects.skipped.push(code);
        continue;
      }
      if (existing) {
        await q.query('DELETE FROM projects WHERE id = $1', [existing.id]);
        report.projects.replaced++;
      } else {
        report.projects.inserted++;
      }

      const ms = M.filter((m) => text(m['Project ID']) === code);
      const orig = ms.map((m) => iso(m['Original Deadline'])).filter(Boolean) as string[];
      const eff = ms.map((m) => iso(m['Effective Deadline']) ?? iso(m['Current Deadline']) ?? iso(m['Original Deadline'])).filter(Boolean) as string[];
      const status = (text(p['Overall Status']) ?? 'Not Started').toLowerCase();
      const gate = text(p['Gate']);
      const derived: Stage = status === 'completed' ? 'closure' : gate === 'PROPOSED' ? 'initiation' : status === 'not started' ? 'planning' : 'execution';
      // A workbook exported from this app carries the real stage; the tracker's own does not.
      const given = (text(p['Stage']) ?? '').toLowerCase();
      const stage: Stage = (STAGES as readonly string[]).includes(given) ? (given as Stage) : derived;
      const start = iso(p['Start Date']) ?? orig.sort()[0] ?? eff.sort()[0] ?? addDays(new Date().toISOString().slice(0, 10), 0);
      const target = iso(p['Target Date']) ?? eff.sort().slice(-1)[0] ?? start;
      // A workbook exported from this app carries the project's baseline; the tracker's own export does not.
      const baselineStart = iso(p['Original Start']) ?? start;
      const baselineEnd = iso(p['Original Target']) ?? target;
      const sponsor = cleanName(p['Executive Sponsor']);
      const ownerName = cleanName(p['Project Owner']);
      countAlias(p['Project Owner']);
      if (ownerName) people.add(ownerName);
      if (sponsor) people.add(sponsor);

      const { rows: pr } = await q.query(
        `INSERT INTO projects (code, name, department_id, owner_name, sponsor, priority, stage, health, gate,
            start_date, end_date, baseline_start, baseline_end, success_metric, success_target, progress, created_by)
         OUTPUT INSERTED.id
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          code,
          text(p['Initiative Name']) ?? code,
          await deptFor(text(p['Category'])),
          ownerName,
          sponsor,
          PRIORITY[(text(p['Priority']) ?? 'medium').toLowerCase()] ?? 'medium',
          stage,
          HEALTH[status] ?? 'not_started',
          gate,
          start,
          target,
          baselineStart,
          baselineEnd,
          text(p['Success Metric']),
          text(p['Success Target']),
          Math.round(Number(p['% Complete'] ?? 0)) || 0,
          owner,
        ],
      );
      const projectId: number = pr[0].id;

      // Phases become summary rows in the order they begin; a milestone with no
      // phase sits at the top level, as it does in the tracker.
      const firstDate = (m: Row) => iso(m['Effective Deadline']) ?? iso(m['Current Deadline']) ?? iso(m['Original Deadline']) ?? '9999-12-31';
      const phases = new Map<string, Row[]>();
      for (const m of ms) {
        const key = text(m['Phase']) ?? '';
        phases.set(key, [...(phases.get(key) ?? []), m]);
      }
      const order = [...phases.entries()].sort(
        (a, b) => a[1].reduce((x, r) => (firstDate(r) < x ? firstDate(r) : x), '9999-12-31').localeCompare(
          b[1].reduce((x, r) => (firstDate(r) < x ? firstDate(r) : x), '9999-12-31'),
        ),
      );
      let sort = 0;
      for (const [phase, rows] of order) {
        rows.sort((a, b) => firstDate(a).localeCompare(firstDate(b)) || String(a['Milestone ID']).localeCompare(String(b['Milestone ID']), undefined, { numeric: true }));
        let parentId: number | null = null;
        if (phase) {
          const d0 = firstDate(rows[0]);
          const { rows: ph } = await q.query(
            `INSERT INTO tasks (project_id, kind, name, start_date, end_date, sort) OUTPUT INSERTED.id VALUES ($1,'summary',$2,$3,$3,$4)`,
            [projectId, phase, d0 === '9999-12-31' ? start : d0, (sort += 10)],
          );
          parentId = ph[0].id;
        }
        for (const m of rows) {
          const mcode = text(m['Milestone ID'])!;
          const origD = iso(m['Original Deadline']);
          let date = iso(m['Effective Deadline']) ?? iso(m['Current Deadline']) ?? origD;
          if (!date) {
            // No deadline in the tracker. The completion date is the best guess, but it
            // must not push a finished project's end past its own target.
            const completed = iso(m['Completed At']);
            const updated = iso(m['Last Update']);
            const guess = completed ?? updated ?? target;
            date = iso(p['Target Date']) && guess > target ? target : guess;
            report.dateFallbacks.push({
              code: mcode,
              usedDate: date,
              from: date === guess ? (completed ? 'Completed At' : updated ? 'Last Update' : 'project target') : 'project target (completion was later)',
            });
          }
          const st = TASK_STATUS[(text(m['Status']) ?? 'Not Started').toLowerCase()] ?? 'todo';
          const progress = st === 'done' ? 100 : Math.max(0, Math.min(100, Math.round(Number(m['% Complete'] ?? 0)) || 0));
          countAlias(m['Responsible Owner']);
          countAlias(m['Co-owners']);
          countAlias(m['Escalate To']);
          const mOwner = cleanList(m['Responsible Owner']);
          if (mOwner) mOwner.split(', ').forEach((n) => people.add(n));
          const depType = text(m['Dependency Type']);
          await q.query(
            `INSERT INTO tasks (project_id, parent_id, kind, code, name, start_date, end_date, baseline_start, baseline_end,
                progress, status, sort, owner_name, co_owners, responsible_dept, escalate_to, blocker, dependency_type,
                last_update_on, update_comment, stream, update_comment_on)
             VALUES ($1,$2,'milestone',$3,$4,$5,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                     CASE WHEN $17 IS NOT NULL THEN CAST($16 AS DATE) END)`,
            [
              projectId,
              parentId,
              mcode,
              text(m['Milestone Description']) ?? mcode,
              date,
              origD ?? date,
              progress,
              st,
              (sort += 10),
              mOwner,
              cleanList(m['Co-owners']),
              text(m['Responsible Department']),
              cleanName(m['Escalate To']),
              text(m['Dependency / Blocker']),
              depType && depType !== 'NONE' ? depType.toLowerCase() : null,
              iso(m['Last Update']),
              text(m['Update Comment']),
              text(m['Stream']),
            ],
          );
          report.milestones++;
        }
      }

      if (ms.length) await resync(q, projectId);
      // The tracker's % complete is authoritative for projects without milestones.
      if (!ms.length) await q.query('UPDATE projects SET progress = $2 WHERE id = $1', [projectId, Math.round(Number(p['% Complete'] ?? 0)) || 0]);

      // A blocker on an open milestone is an open issue on the project. One
      // issue per distinct blocker, listing the milestones it holds up.
      const blockers = new Map<string, { codes: string[]; due: string }>();
      for (const m of ms) {
        const b = text(m['Dependency / Blocker']);
        if (!b || text(m['Status']) === 'Completed' || text(m['Status']) === 'Cancelled') continue;
        const cur = blockers.get(b) ?? { codes: [], due: '9999-12-31' };
        cur.codes.push(String(m['Milestone ID']));
        const d = iso(m['Effective Deadline']) ?? iso(m['Current Deadline']) ?? iso(m['Original Deadline']) ?? cur.due;
        if (d < cur.due) cur.due = d;
        blockers.set(b, cur);
      }
      for (const [b, v] of blockers) {
        await q.query(
          `INSERT INTO risks (project_id, kind, title, impact, likelihood, status, mitigation, due_date)
           VALUES ($1,'issue',$2,'medium','high','open',$3,$4)`,
          [projectId, b.slice(0, 240), `Holds up ${v.codes.join(', ')}. Imported from the tracker.`, v.due === '9999-12-31' ? null : v.due],
        );
        report.blockerIssues++;
      }
      await q.query(`INSERT INTO activity (project_id, user_id, action, detail) VALUES ($1,$2,'project.imported',$3)`, [
        projectId,
        owner,
        JSON.stringify({ code, milestones: ms.length, source: path.basename(file) }),
      ]);
    }
    await linkPeople(q);
  });

  report.people = [...people].sort();

  // ---- Check against counts taken from the spreadsheet itself ----
  const problems: string[] = [];
  const dbProjects = (await db.query(`SELECT code, health, progress, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone') AS ms,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone' AND t.status = 'done') AS done
      FROM projects p`)).rows as { code: string; health: string; progress: number; ms: number; done: number }[];
  const byCode = new Map(dbProjects.map((r) => [r.code, r]));
  for (const p of P) {
    const code = text(p['Project ID'])!;
    if (report.projects.skipped.includes(code)) continue;
    const r = byCode.get(code);
    if (!r) {
      problems.push(`${code}: missing from the database`);
      continue;
    }
    const srcMs = M.filter((m) => text(m['Project ID']) === code);
    if (r.ms !== srcMs.length) problems.push(`${code}: ${r.ms} milestones imported, ${srcMs.length} in the file`);
    const srcDone = srcMs.filter((m) => text(m['Status']) === 'Completed').length;
    if (r.done !== srcDone) problems.push(`${code}: ${r.done} completed, ${srcDone} in the file`);
    const expectedHealth = HEALTH[(text(p['Overall Status']) ?? '').toLowerCase()];
    if (r.health !== expectedHealth) problems.push(`${code}: health ${r.health}, file says ${expectedHealth}`);
    const trackerPct = Math.round(Number(p['% Complete'] ?? 0));
    if (Math.abs(r.progress - trackerPct) > 1) problems.push(`${code}: ${r.progress}% complete here, ${trackerPct}% in the tracker`);
  }
  const totalMs = (await db.query(`SELECT COUNT(*) AS n FROM tasks WHERE kind = 'milestone'`)).rows[0].n;
  const expectedMs = M.filter((m) => !report.projects.skipped.includes(text(m['Project ID'])!)).length;
  if (totalMs < expectedMs) problems.push(`Total milestones in the database ${totalMs}, expected at least ${expectedMs}`);

  fs.mkdirSync(path.resolve('data'), { recursive: true });
  fs.writeFileSync(path.resolve('data/import-report.json'), JSON.stringify({ ...report, problems }, null, 2));
  console.log(
    `Projects: ${report.projects.inserted} added, ${report.projects.replaced} replaced, ${report.projects.skipped.length} skipped.`,
  );
  console.log(`Milestones: ${report.milestones}. Blocker issues: ${report.blockerIssues}. Date fallbacks: ${report.dateFallbacks.length}.`);
  console.log('Aliases applied:', JSON.stringify(report.aliasesApplied));
  console.log('Report: data/import-report.json');
  if (problems.length) {
    console.error(`\n${problems.length} PROBLEM(S):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Checked against the spreadsheet: every project, milestone, completion count, status and % complete matches.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
