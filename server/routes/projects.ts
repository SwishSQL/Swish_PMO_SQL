import { Router } from 'express';
import type { Request } from 'express';
import { db } from '../db';
import type { Queryable } from '../db';
import { HttpError, can, canEditProject, canGovernProject, canViewProject, isMyTask, requirePermission, route, seesAllProjects, seesWholePlan } from '../auth';
import { mapDependency, mapMilestoneUpdate, mapNote, mapRisk, mapTask, mapUpdate } from '../mappers';
import { listProjects, loadDetail, logActivity, myTaskIds, nextProjectCode, restrictDetail, restrictPlan, resync, runProjectIds } from '../service';
import { linkPeople } from '../people';
import { deciders, notify } from '../notify';
import { loadCalendar } from '../calendar';
import { projectVisibleSql, taskVisibleSql } from '../visibility';
import { date, idParam, int, oneOf, optDate, optInt, optStr, str } from '../validate';
import { HEALTHS, PRIORITIES, STAGES } from '../../shared/types';
import type { Task } from '../../shared/types';
import { createsCycle } from '../../shared/schedule';
import { isBaselined, lockedError, pushSuccessors } from '../plan';
import { addDays, diffDays, todayIso, weekStart } from '../../shared/dates';
import { PROJECT_PHASES } from '../../shared/phases';

export const projectsRouter = Router();

async function assertCanEdit(req: Request, projectId: number): Promise<void> {
  if (!(await canEditProject(req, projectId))) {
    throw new HttpError(403, 'Only the PMO and this project team can change it.');
  }
}

/**
 * Nobody marks a project finished alone: stage Closed and health Done are set by approving a closure
 * request, or directly by those who hold that approval (the PMO admin).
 */
function assertMayFinish(req: Request, field: 'stage' | 'health', value: unknown, current: string | null): void {
  const finishing = field === 'stage' ? value === 'closed' : value === 'done';
  if (finishing && value !== current && !can(req, 'projects.approve_close')) {
    throw new HttpError(403, 'A project is closed only after a PMO admin approves it. Send a closure request from the project.');
  }
}

/** Adding, removing, ordering and linking tasks: the project's owner, its department head and the PMO. */
async function assertCanPlan(req: Request, projectId: number): Promise<void> {
  if (!(await canGovernProject(req, projectId))) {
    throw new HttpError(403, 'Only the project owner (or the PMO) adds, removes, orders and links tasks. You can report on the tasks given to you.');
  }
}

async function assertCanGovern(req: Request, projectId: number, what: string): Promise<void> {
  if (!(await canGovernProject(req, projectId))) {
    throw new HttpError(403, `Only the PMO or this project's manager can change ${what}.`);
  }
}

/** Project fields that only the PMO or the project manager may change, with their labels. */
const GOVERNED: Record<string, string> = {
  managerId: 'the project manager',
  departmentId: 'the department',
  quarterId: 'the quarter',
  priority: 'the priority',
  stage: 'the stage',
  health: 'the health status',
  budget: 'the budget',
  startDate: 'the project dates',
  endDate: 'the project dates',
};

/** A parent must be a row of the same project: otherwise a task could be hung under another project's phase. */
async function assertTaskInProject(taskId: number, projectId: number): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [taskId, projectId]);
  if (!rows[0]) throw new HttpError(400, 'That parent is not in this project.');
}

/**
 * The plan's shape: phases hold milestones, and a milestone holds the tasks that lead to it. A phase sits at the top
 * (or inside another phase), a milestone at the top or inside a phase, and a task only inside a milestone.
 */
const FITS: Record<string, (string | null)[]> = { summary: [null, 'summary'], milestone: [null, 'summary'], task: ['milestone'] };
const MISFIT: Record<string, string> = {
  task: 'A task goes inside a milestone: select the milestone first, then add the task.',
  milestone: 'A milestone goes inside a phase (or at the top of the plan), not inside a task or another milestone.',
  summary: 'A phase goes at the top of the plan, or inside another phase.',
};
async function assertFits(kind: string, parentId: number | null): Promise<void> {
  const parentKind = parentId ? ((await db.query('SELECT kind FROM tasks WHERE id = $1', [parentId])).rows[0]?.kind ?? null) : null;
  if (!FITS[kind]?.includes(parentKind)) throw new HttpError(400, MISFIT[kind] ?? 'That cannot go there.');
}
/** Changing what an item is must leave what is under it in a valid place. */
async function assertChildrenFit(taskId: number, kind: string): Promise<void> {
  const { rows } = await db.query('SELECT kind FROM tasks WHERE parent_id = $1', [taskId]);
  for (const r of rows) {
    if (!FITS[r.kind]?.includes(kind)) throw new HttpError(400, 'What is under this item cannot stay under it as that type. Move it first.');
  }
}

/** Anyone but the PMO gives work only to people of the project's own department. */
async function assertAssignable(req: Request, projectId: number, assigneeId: number | null): Promise<void> {
  if (!assigneeId || can(req, 'projects.edit_all')) return;
  const { rows } = await db.query(
    `SELECT 1 FROM projects p JOIN users u ON u.id = $2 WHERE p.id = $1 AND u.department_id = p.department_id`,
    [projectId, assigneeId],
  );
  if (!rows.length) throw new HttpError(400, 'Work can be given only to people of the department that owns the project.');
}

async function projectOfTask(taskId: number): Promise<number> {
  const { rows } = await db.query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
  if (!rows[0]) throw new HttpError(404, 'Task not found.');
  return rows[0].project_id;
}

async function planOf(projectId: number) {
  const [tasks, deps] = await Promise.all([
    db.query('SELECT * FROM tasks WHERE project_id = $1 ORDER BY sort, id', [projectId]),
    db.query('SELECT * FROM task_dependencies WHERE project_id = $1', [projectId]),
  ]);
  const { rows } = await db.query('SELECT start_date, end_date, progress FROM projects WHERE id = $1', [projectId]);
  return {
    tasks: tasks.rows.map(mapTask),
    dependencies: deps.rows.map(mapDependency),
    project: { startDate: rows[0].start_date, endDate: rows[0].end_date, progress: rows[0].progress },
  };
}

// ---- Portfolio --------------------------------------------------------------

projectsRouter.get(
  '/projects',
  route(async (req, res) => {
    const quarter = optInt(req.query.quarter, 'Quarter');
    const list = await listProjects(quarter, seesAllProjects(req) ? null : req.user!.id);
    if (seesAllProjects(req)) {
      res.json(list);
      return;
    }
    // Where the person only works, the route map shows just their own milestones.
    const [runs, mine] = await Promise.all([runProjectIds(req.user!.id), myTaskIds(req.user!.id)]);
    res.json(list.map((p) => (runs.has(p.id) ? p : { ...p, milestones: p.milestones.filter((m) => mine.has(m.id)) })));
  }),
);

projectsRouter.post(
  '/projects',
  route(async (req, res) => {
    const b = req.body ?? {};
    const name = str(b.name, 'Project name', 160);
    const startDate = date(b.startDate, 'Start date');
    const endDate = date(b.endDate, 'End date');
    if (endDate < startDate) throw new HttpError(400, 'The end date is before the start date.');
    const departmentId = int(b.departmentId, 'Department');
    // Only a department head starts projects, in the departments they head. The company owner starts one in
    // any department, which hands it to that department's head. The PMO can do either.
    const { rows: dep } = await db.query('SELECT head_user_id FROM departments WHERE id = $1', [departmentId]);
    if (!dep[0]) throw new HttpError(400, 'That department does not exist.');
    const mayStart =
      can(req, 'projects.edit_all') ||
      can(req, 'projects.assign') ||
      (can(req, 'projects.create') && dep[0].head_user_id === req.user!.id);
    if (!mayStart) {
      throw new HttpError(403, 'Only the head of a department starts a project, and only in their own department. Ask the department head, or the company owner.');
    }
    // The owner is whoever the creator names; failing that the department head, failing that the creator.
    const managerId = optInt(b.managerId, 'Project owner') ?? dep[0].head_user_id ?? req.user!.id;
    const milestones: { name: string; date: string; phase?: string }[] = Array.isArray(b.milestones) ? b.milestones : [];

    const id = await db.tx(async (q) => {
      const code = await nextProjectCode(q);
      const { rows } = await q.query(
        `INSERT INTO projects (code, name, name_ar, description, objective, scope, department_id, manager_id,
            sponsor, quarter_id, priority, stage, start_date, end_date, budget, created_by)
         OUTPUT INSERTED.id
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'initiation',$12,$13,$14,$15)`,
        [
          code,
          name,
          optStr(b.nameAr, 'Arabic name', 160),
          optStr(b.description, 'Description'),
          optStr(b.objective, 'Objective'),
          optStr(b.scope, 'Scope'),
          departmentId,
          managerId,
          optStr(b.sponsor, 'Sponsor', 120),
          optInt(b.quarterId, 'Quarter'),
          b.priority ? oneOf(b.priority, 'Priority', PRIORITIES) : 'medium',
          startDate,
          endDate,
          b.budget === '' || b.budget == null ? null : Number(b.budget),
          req.user!.id,
        ],
      );
      const projectId: number = rows[0].id;
      await q.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'Project manager')`, [
        projectId,
        managerId,
      ]);
      for (const userId of Array.isArray(b.memberIds) ? b.memberIds : []) {
        if (Number(userId) === managerId) continue;
        await q.query(
          `INSERT INTO project_members (project_id, user_id, role) SELECT $1, $2, 'Member'
            WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2)`,
          [projectId, int(userId, 'Member')],
        );
      }
      // The fixed phases, in order. Those the creator ticked share the project's window one after the other; the
      // rest stay in the plan, marked Not required, on the first day.
      const wanted = new Set<string>(Array.isArray(b.phases) ? b.phases.map(String) : PROJECT_PHASES);
      const chosen = PROJECT_PHASES.filter((p) => wanted.has(p));
      const span = diffDays(startDate, endDate) + 1;
      let slot = 0;
      let sort = 0;
      const phaseRows: { id: number; name: string; from: string; to: string }[] = [];
      for (const phase of PROJECT_PHASES) {
        const used = wanted.has(phase);
        const from = used ? addDays(startDate, Math.floor((slot * span) / chosen.length)) : startDate;
        const to = used ? addDays(startDate, Math.max(Math.floor(((slot + 1) * span) / chosen.length) - 1, Math.floor((slot * span) / chosen.length))) : startDate;
        if (used) slot += 1;
        const { rows: ph } = await q.query(
          `INSERT INTO tasks (project_id, kind, name, start_date, end_date, sort, not_required) OUTPUT INSERTED.id VALUES ($1, 'summary', $2, $3, $4, $5, $6)`,
          [projectId, phase, from, to, (sort += 10), !used],
        );
        if (used) phaseRows.push({ id: ph[0].id, name: phase, from, to });
      }
      // Each milestone goes inside a phase: the one it names, else the one whose time it falls in, else the last one
      // that has started by then. With no phase ticked it stays at the top of the plan.
      const phaseFor = (name: unknown, d: string): number | null => {
        if (!phaseRows.length) return null;
        const named = phaseRows.find((p) => p.name === name);
        if (named) return named.id;
        const inside = phaseRows.find((p) => p.from <= d && d <= p.to);
        if (inside) return inside.id;
        const started = phaseRows.filter((p) => p.from <= d);
        return (started[started.length - 1] ?? phaseRows[0]).id;
      };
      for (const m of milestones) {
        if (!m?.name?.trim()) continue;
        const d = date(m.date, 'Milestone date');
        await q.query(
          `INSERT INTO tasks (project_id, parent_id, kind, name, start_date, end_date, sort) VALUES ($1, $2, 'milestone', $3, $4, $4, $5)`,
          [projectId, phaseFor((m as { phase?: unknown }).phase, d), str(m.name, 'Milestone name', 160), d, (sort += 10)],
        );
      }
      await resync(q, projectId);
      await logActivity(q, projectId, req.user!.id, 'project.created', { code, name });
      return projectId;
    });
    // The owner and the team named at creation hear, as anyone added to a team later does, and so does the
    // head of the department the project was started in (the chain: company owner, department head, owner).
    const { rows: team } = await db.query('SELECT user_id FROM project_members WHERE project_id = $1', [id]);
    const ownerId = team.length ? (await db.query('SELECT manager_id FROM projects WHERE id = $1', [id])).rows[0]?.manager_id ?? null : null;
    await notify(db, [ownerId], { kind: 'project.owner', projectId: id, data: { project: name, by: req.user!.name } }, req.user!.id);
    await notify(db, team.map((r) => r.user_id).filter((u) => u !== ownerId), { kind: 'team.added', projectId: id, data: { project: name, by: req.user!.name } }, req.user!.id);
    if (dep[0].head_user_id && !team.some((r) => r.user_id === dep[0].head_user_id)) {
      await notify(db, [dep[0].head_user_id], { kind: 'project.assigned', projectId: id, data: { project: name, by: req.user!.name } }, req.user!.id);
    }
    res.status(201).json(await loadDetail(id));
  }),
);

projectsRouter.get(
  '/projects/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await canViewProject(req, id))) throw new HttpError(404, 'Project not found.');
    const detail = await loadDetail(id);
    if (!detail) throw new HttpError(404, 'Project not found.');
    res.json((await seesWholePlan(req, id)) ? detail : restrictDetail(detail, await myTaskIds(req.user!.id, id)));
  }),
);

projectsRouter.patch(
  '/projects/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanGovern(req, id, 'the project details');
    const b = req.body ?? {};
    // The details form sends every field on save: only a real change to a governed one needs the manager or the PMO.
    const { rows: curRows } = await db.query('SELECT * FROM projects WHERE id = $1', [id]);
    const cur = curRows[0];
    if (!cur) throw new HttpError(404, 'Project not found.');
    const COLUMN: Record<string, string> = {
      managerId: 'manager_id',
      departmentId: 'department_id',
      quarterId: 'quarter_id',
      priority: 'priority',
      stage: 'stage',
      health: 'health',
      budget: 'budget',
      startDate: 'start_date',
      endDate: 'end_date',
    };
    const norm = (v: unknown) => (v === '' || v === undefined || v === null ? null : String(v));
    const normNum = (v: unknown) => (v === '' || v === undefined || v === null ? null : Number(v));
    const differs = (k: string) =>
      ['managerId', 'departmentId', 'quarterId', 'budget'].includes(k)
        ? normNum(b[k]) !== normNum(cur[COLUMN[k]])
        : norm(b[k]) !== norm(cur[COLUMN[k]]);
    const governed = [...new Set(Object.keys(b).filter((k) => k in GOVERNED && differs(k)).map((k) => GOVERNED[k]))];
    if (governed.length) await assertCanGovern(req, id, governed.join(', '));
    if ('stage' in b) assertMayFinish(req, 'stage', b.stage, cur.stage);
    if ('health' in b) assertMayFinish(req, 'health', b.health, cur.health);
    // After the baseline, the project's dates, budget, scope and objective change only through an approved change request.
    if (await isBaselined(db, id)) {
      const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '') || null;
      const touched = [
        'startDate' in b && differs('startDate') && 'dates',
        'endDate' in b && differs('endDate') && 'dates',
        'budget' in b && differs('budget') && 'budget',
        'scope' in b && text(b.scope) !== text(cur.scope) && 'scope',
        'objective' in b && text(b.objective) !== text(cur.objective) && 'objective',
      ].filter(Boolean);
      if (touched.length) throw lockedError(`its ${[...new Set(touched)].join(', ')}`);
    }
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const changed: string[] = [];
    const set = (col: string, v: unknown, label: string) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
      changed.push(label);
    };
    if ('name' in b) set('name', str(b.name, 'Project name', 160), 'name');
    if ('nameAr' in b) set('name_ar', optStr(b.nameAr, 'Arabic name', 160), 'Arabic name');
    if ('description' in b) set('description', optStr(b.description, 'Description'), 'description');
    if ('objective' in b) set('objective', optStr(b.objective, 'Objective'), 'objective');
    if ('scope' in b) set('scope', optStr(b.scope, 'Scope'), 'scope');
    if ('sponsor' in b) set('sponsor', optStr(b.sponsor, 'Sponsor', 120), 'sponsor');
    if ('ownerName' in b) set('owner_name', optStr(b.ownerName, 'Owner', 160), 'owner');
    if ('successMetric' in b) set('success_metric', optStr(b.successMetric, 'Success metric', 2000), 'success metric');
    if ('successTarget' in b) set('success_target', optStr(b.successTarget, 'Success target', 2000), 'success target');
    if ('departmentId' in b) set('department_id', int(b.departmentId, 'Department'), 'department');
    if ('managerId' in b) set('manager_id', optInt(b.managerId, 'Project manager'), 'project manager');
    if ('quarterId' in b) set('quarter_id', optInt(b.quarterId, 'Quarter'), 'quarter');
    if ('priority' in b) set('priority', oneOf(b.priority, 'Priority', PRIORITIES), 'priority');
    if ('stage' in b) set('stage', oneOf(b.stage, 'Stage', STAGES), 'stage');
    if ('health' in b) set('health', oneOf(b.health, 'Health', HEALTHS), 'health');
    if ('budget' in b) set('budget', b.budget === '' || b.budget == null ? null : Number(b.budget), 'budget');
    if ('startDate' in b) set('start_date', date(b.startDate, 'Start date'), 'start date');
    if ('endDate' in b) set('end_date', date(b.endDate, 'End date'), 'end date');
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    await db.tx(async (q) => {
      await q.query(`UPDATE projects SET ${sets.join(', ')}, updated_at = SYSDATETIMEOFFSET() WHERE id = $1`, vals);
      if ('managerId' in b && b.managerId) {
        await q.query(
          `UPDATE project_members SET role = 'Project manager' WHERE project_id = $1 AND user_id = $2;
           IF @@ROWCOUNT = 0 INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'Project manager')`,
          [id, b.managerId],
        );
      }
      // Before and after for the calls that matter in the weekly review.
      await logActivity(q, id, req.user!.id, 'project.updated', {
        fields: changed,
        ...('stage' in b && b.stage !== cur.stage ? { stage: b.stage, stageFrom: cur.stage } : {}),
        ...('health' in b && b.health !== cur.health ? { health: b.health, healthFrom: cur.health } : {}),
        ...('managerId' in b && differs('managerId') ? { managerFrom: cur.manager_id, managerTo: b.managerId || null } : {}),
      });
    });
    if ('managerId' in b && Number(b.managerId) && Number(b.managerId) !== cur.manager_id) {
      await notify(db, [Number(b.managerId)], { kind: 'project.owner', projectId: id, data: { project: cur.name, by: req.user!.name } }, req.user!.id);
    }
    res.json(await loadDetail(id));
  }),
);

projectsRouter.post(
  '/projects/:id/archive',
  requirePermission('projects.archive'),
  route(async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await canViewProject(req, id))) throw new HttpError(404, 'Project not found.');
    await db.query('UPDATE projects SET archived = 1, updated_at = SYSDATETIMEOFFSET() WHERE id = $1', [id]);
    await logActivity(db, id, req.user!.id, 'project.archived');
    res.json({ ok: true });
  }),
);

/**
 * The baseline is the plan the project is measured against: the original
 * deadlines (for imported projects, the tracker's). Two ways to set it:
 * - mode 'missing' (default, the project team): fills a baseline only on items
 *   that have none yet, such as tasks added since. Nothing is overwritten.
 * - mode 'all' (the PMO only, with a reason): replaces every baseline with the
 *   current dates. Slips start counting from zero, so it is a recorded decision.
 */
projectsRouter.post(
  '/projects/:id/baseline',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanEdit(req, id);
    const mode = oneOf(req.body?.mode ?? 'missing', 'Mode', ['missing', 'all'] as const);
    if (mode === 'all') {
      if (!can(req, 'projects.edit_all')) {
        throw new HttpError(403, 'Only the PMO can re-baseline a whole project. Ask them, giving the reason.');
      }
      const reason = str(req.body?.reason, 'Reason', 500);
      if (reason.trim().length < 5) throw new HttpError(400, 'Give the reason for re-baselining.');
      await db.tx(async (q) => {
        const { rows } = await q.query(
          `SELECT count(*) AS n FROM tasks
            WHERE project_id = $1
              AND (baseline_start <> start_date OR (baseline_start IS NULL AND start_date IS NOT NULL) OR (baseline_start IS NOT NULL AND start_date IS NULL)
                OR baseline_end <> end_date OR (baseline_end IS NULL AND end_date IS NOT NULL) OR (baseline_end IS NOT NULL AND end_date IS NULL))`,
          [id],
        );
        const { rows: before } = await q.query('SELECT baseline_start, baseline_end FROM projects WHERE id = $1', [id]);
        await q.query('UPDATE tasks SET baseline_start = start_date, baseline_end = end_date WHERE project_id = $1', [id]);
        await q.query(
          'UPDATE projects SET baseline_start = start_date, baseline_end = end_date, updated_at = SYSDATETIMEOFFSET() WHERE id = $1',
          [id],
        );
        await logActivity(q, id, req.user!.id, 'baseline.reset', {
          reason,
          itemsChanged: rows[0].n,
          from: [before[0]?.baseline_start ?? null, before[0]?.baseline_end ?? null],
        });
      });
    } else {
      await db.tx(async (q) => {
        const { rows } = await q.query(
          `UPDATE tasks SET baseline_start = start_date, baseline_end = end_date OUTPUT INSERTED.id
            WHERE project_id = $1 AND baseline_end IS NULL`,
          [id],
        );
        await q.query(
          `UPDATE projects SET baseline_start = start_date, baseline_end = end_date, updated_at = SYSDATETIMEOFFSET()
            WHERE id = $1 AND baseline_end IS NULL`,
          [id],
        );
        await logActivity(q, id, req.user!.id, 'baseline.filled', { items: rows.length });
      });
    }
    res.json(await loadDetail(id));
  }),
);

projectsRouter.put(
  '/projects/:id/members',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanGovern(req, id, 'the team');
    const list: { userId: number; role: string }[] = Array.isArray(req.body?.members) ? req.body.members : [];
    const { rows: was } = await db.query('SELECT user_id FROM project_members WHERE project_id = $1', [id]);
    // People already on the team stay; anyone new must belong to the project's department (the PMO may cross).
    const already = new Set(was.map((r) => Number(r.user_id)));
    for (const m of list) if (!already.has(Number(m.userId))) await assertAssignable(req, id, int(m.userId, 'Member'));
    await db.tx(async (q) => {
      await q.query('DELETE FROM project_members WHERE project_id = $1', [id]);
      for (const m of list) {
        await q.query(
          `INSERT INTO project_members (project_id, user_id, role) SELECT $1, $2, $3
            WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2)`,
          [id, int(m.userId, 'Member'), str(m.role || 'Member', 'Role', 80)],
        );
      }
      await logActivity(q, id, req.user!.id, 'team.updated', { size: list.length });
    });
    const old = new Set(was.map((r) => r.user_id));
    const { rows: pname } = await db.query('SELECT name FROM projects WHERE id = $1', [id]);
    await notify(db, list.map((m) => Number(m.userId)).filter((u) => !old.has(u)), { kind: 'team.added', projectId: id, data: { project: pname[0]?.name, by: req.user!.name } }, req.user!.id);
    res.json(await loadDetail(id));
  }),
);

// ---- Plan: tasks and dependencies -------------------------------------------

projectsRouter.post(
  '/projects/:id/tasks',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanPlan(req, id);
    const b = req.body ?? {};
    const kind = oneOf(b.kind ?? 'task', 'Kind', ['summary', 'task', 'milestone'] as const);
    const startDate = date(b.startDate, 'Start date');
    const endDate = kind === 'milestone' ? startDate : date(b.endDate ?? b.startDate, 'End date');
    if (endDate < startDate) throw new HttpError(400, 'The finish is before the start.');
    const parentId = optInt(b.parentId, 'Parent');
    if (parentId) {
      await assertTaskInProject(parentId, id);
      const { rows: par } = await db.query('SELECT not_required, name FROM tasks WHERE id = $1', [parentId]);
      if (par[0]?.not_required) throw new HttpError(400, `The phase "${par[0].name}" is marked Not required. Switch it back on to put work in it.`);
    }
    await assertFits(kind, parentId);
    if (kind === 'milestone' && (await isBaselined(db, id))) throw lockedError('a new milestone (a change of scope)');
    const afterId = optInt(b.afterId, 'Position');
    await assertAssignable(req, id, optInt(b.assigneeId, 'Assignee'));
    await db.tx(async (q) => {
      let sort: number;
      if (afterId) {
        const { rows } = await q.query('SELECT sort FROM tasks WHERE id = $1 AND project_id = $2', [afterId, id]);
        sort = (rows[0]?.sort ?? 0) + 1;
        await q.query('UPDATE tasks SET sort = sort + 1 WHERE project_id = $1 AND sort >= $2', [id, sort]);
      } else {
        const { rows } = await q.query('SELECT COALESCE(max(sort), 0) + 10 AS s FROM tasks WHERE project_id = $1', [id]);
        sort = rows[0].s;
      }
      const { rows } = await q.query(
        `INSERT INTO tasks (project_id, parent_id, kind, name, start_date, end_date, assignee_id, sort)
         OUTPUT INSERTED.id VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, parentId, kind, str(b.name, 'Task name', 200), startDate, endDate, optInt(b.assigneeId, 'Assignee'), sort],
      );
      await resync(q, id);
      await logActivity(q, id, req.user!.id, 'task.created', { taskId: rows[0].id, name: b.name, kind });
    });
    res.status(201).json(await planOf(id));
  }),
);

projectsRouter.patch(
  '/tasks/:taskId',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const projectId = await projectOfTask(taskId);
    await assertCanEdit(req, projectId);
    const b = req.body ?? {};
    const { rows: cur } = await db.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    const task: Task = mapTask(cur[0]);
    // The owner plans and assigns. Everyone else reports on the tasks given to them, and on those alone.
    if (!(await canGovernProject(req, projectId))) {
      if (!(await isMyTask(req.user!.id, taskId))) throw new HttpError(403, 'This task is not given to you. Only the project owner changes the tasks of others.');
      for (const k of ['assigneeId', 'parentId', 'kind', 'name', 'notRequired']) {
        if (k in b && String(b[k] ?? '') !== String((task as any)[k] ?? '')) throw new HttpError(403, 'Only the project owner assigns work and restructures the plan.');
      }
    }
    if ('assigneeId' in b && Number(b.assigneeId) !== task.assigneeId) await assertAssignable(req, projectId, optInt(b.assigneeId, 'Assignee'));
    const sets: string[] = [];
    const vals: unknown[] = [taskId];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    const kind = 'kind' in b ? oneOf(b.kind, 'Kind', ['summary', 'task', 'milestone'] as const) : task.kind;
    // Turning a milestone into a plain task would let it be deleted without the manager.
    if (task.kind === 'milestone' && kind !== 'milestone') await assertCanGovern(req, projectId, 'milestones (type)');
    const newParent = 'parentId' in b ? optInt(b.parentId, 'Parent') : task.parentId;
    if (('parentId' in b && newParent !== task.parentId) || kind !== task.kind) await assertFits(kind, newParent);
    if (kind !== task.kind) await assertChildrenFit(taskId, kind);
    if ('kind' in b) set('kind', kind);
    if ('name' in b) set('name', str(b.name, 'Task name', 200));
    let start = 'startDate' in b ? date(b.startDate, 'Start date') : task.startDate;
    let end = 'endDate' in b ? date(b.endDate, 'Finish date') : task.endDate;
    if (kind === 'milestone') end = start = 'endDate' in b && !('startDate' in b) ? end : start;
    if (end < start) throw new HttpError(400, 'The finish is before the start.');
    const moved = start !== task.startDate || end !== task.endDate;
    // A milestone's deadline is a commitment: moving it needs a reason, and leaves a record the PMO can follow.
    let changeReason: string | null = null;
    if (task.kind === 'milestone' && kind === 'milestone' && end !== task.endDate) {
      changeReason = str(b.changeReason, 'The reason for the new deadline', 500).trim();
      if (changeReason.length < 5) throw new HttpError(400, 'Give the reason for the new deadline.');
    }
    if (task.kind === 'milestone' && (await isBaselined(db, projectId))) {
      if (end !== task.endDate) throw lockedError("a milestone's date");
      if (kind !== 'milestone') throw lockedError('a milestone (turning it into something else)');
      if ('status' in b && b.status === 'cancelled' && task.status !== 'cancelled') throw lockedError('a milestone (cancelling it)');
    }
    const governs = changeReason ? await canGovernProject(req, projectId) : false;
    if (moved) {
      set('start_date', start);
      set('end_date', end);
    }
    // A status report from the owner: a new comment, or a change to status,
    // % complete or blocker. It moves "Latest update", the date the weekly
    // review and the needs-update check read. Moving dates or renaming does not.
    let reported = 'updateComment' in b;
    let progress: number | null = null;
    if ('progress' in b) progress = int(b.progress, 'Progress', 0, 100);
    if ('status' in b) {
      const status = oneOf(b.status, 'Status', ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const);
      set('status', status);
      if (status !== task.status) reported = true;
      if (status === 'done' && progress === null) progress = 100;
    }
    if (progress !== null && progress !== task.progress) reported = true;
    if (progress !== null) {
      set('progress', progress);
      // Moving the slider never un-cancels or un-blocks an item.
      if (!('status' in b) && task.status !== 'cancelled' && task.status !== 'blocked') {
        set('status', progress >= 100 ? 'done' : progress > 0 ? 'in_progress' : 'todo');
      }
    }
    if ('assigneeId' in b) set('assignee_id', optInt(b.assigneeId, 'Assignee'));
    if ('notRequired' in b) {
      if (task.kind !== 'summary') throw new HttpError(400, 'Only a phase can be marked Not required.');
      const flag = b.notRequired === true;
      if (flag) {
        const { rows: kids } = await db.query('SELECT count(*) AS n FROM tasks WHERE parent_id = $1', [taskId]);
        if (kids[0].n > 0) throw new HttpError(400, 'This phase has work in it. Move or remove that work before marking it Not required.');
      }
      set('not_required', flag);
    }
    if ('notes' in b) set('notes', optStr(b.notes, 'Notes'));
    if ('ownerName' in b) set('owner_name', optStr(b.ownerName, 'Owner', 160));
    if ('coOwners' in b) set('co_owners', optStr(b.coOwners, 'Co-owners', 300));
    if ('responsibleDept' in b) set('responsible_dept', optStr(b.responsibleDept, 'Responsible department', 160));
    if ('escalateTo' in b) set('escalate_to', optStr(b.escalateTo, 'Escalate to', 160));
    if ('blocker' in b) {
      const blocker = optStr(b.blocker, 'Blocker', 1000);
      set('blocker', blocker);
      if ((blocker ?? null) !== (task.blocker ?? null)) reported = true;
    }
    let postedComment: string | null = null;
    if ('updateComment' in b) {
      postedComment = optStr(b.updateComment, 'Update', 4000);
      set('update_comment', postedComment);
      set('update_comment_on', postedComment ? todayIso() : null);
    }
    if (reported) set('last_update_on', todayIso());
    if ('parentId' in b) {
      const parentId = optInt(b.parentId, 'Parent');
      if (parentId === taskId) throw new HttpError(400, 'A task cannot sit under itself.');
      if (parentId) await assertTaskInProject(parentId, projectId);
      if (parentId) {
        // Walk up from the new parent: landing under one's own child would loop.
        let cursor: number | null = parentId;
        while (cursor) {
          if (cursor === taskId) throw new HttpError(400, 'A task cannot sit under one of its own subtasks.');
          const found: { rows: { parent_id: number | null }[] } = await db.query(
            'SELECT parent_id FROM tasks WHERE id = $1',
            [cursor],
          );
          cursor = found.rows[0]?.parent_id ?? null;
        }
        const { rows: par } = await db.query('SELECT not_required, name FROM tasks WHERE id = $1', [parentId]);
        if (par[0]?.not_required) throw new HttpError(400, `The phase "${par[0].name}" is marked Not required. Switch it back on to put work in it.`);
      }
      set('parent_id', parentId);
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    await db.tx(async (q) => {
      await q.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, vals);
      if (changeReason) {
        await q.query(
          `INSERT INTO deadline_changes (task_id, from_date, to_date, reason, requested_by, status, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [taskId, task.endDate, end, changeReason, req.user!.id, governs ? 'approved' : 'pending', governs ? req.user!.id : null, governs ? new Date() : null],
        );
        // The original deadline is written once, the first time a milestone moves, and never again.
        await q.query('UPDATE tasks SET baseline_start = COALESCE(baseline_start, $2), baseline_end = COALESCE(baseline_end, $3) WHERE id = $1', [
          taskId,
          task.startDate,
          task.endDate,
        ]);
      }
      if (reported) {
        // One history row per report, holding the state after it.
        await q.query(
          `INSERT INTO milestone_updates (task_id, author_id, status, progress, comment, blocker)
           SELECT id, $2, status, progress, $3, blocker FROM tasks WHERE id = $1`,
          [taskId, req.user!.id, postedComment],
        );
      }
      if (moved) await pushSuccessors(q, projectId, taskId, task.name);
      await resync(q, projectId);
      if (moved || progress !== null) {
        await logActivity(q, projectId, req.user!.id, moved ? 'task.moved' : 'task.progress', {
          taskId,
          name: task.name,
          from: moved ? [task.startDate, task.endDate] : task.progress,
          to: moved ? [start, end] : progress,
        });
      }
    });
    if (changeReason && !governs) {
      await notify(db, await deciders(db, projectId), {
        kind: 'deadline.pending',
        projectId,
        taskId,
        data: { name: task.name, from: task.endDate, to: end, reason: changeReason, by: req.user!.name },
      }, req.user!.id);
    }
    if ('assigneeId' in b && b.assigneeId && Number(b.assigneeId) !== task.assigneeId) {
      await notify(db, [Number(b.assigneeId)], { kind: 'task.assigned', projectId, taskId, data: { name: task.name, by: req.user!.name } }, req.user!.id);
    }
    if ('coOwners' in b || 'ownerName' in b) {
      await db.query('DELETE FROM task_coowners WHERE task_id = $1', [taskId]);
      await linkPeople();
    }
    const plan = await planOf(projectId);
    res.json((await seesWholePlan(req, projectId)) ? plan : restrictPlan(plan, await myTaskIds(req.user!.id, projectId)));
  }),
);

/** Every update posted on a task, newest first. Whoever may see the project may read its history. */
projectsRouter.get(
  '/tasks/:taskId/updates',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const projectId = await projectOfTask(taskId);
    if (!(await canViewProject(req, projectId))) throw new HttpError(404, 'Task not found.');
    if (!(await seesWholePlan(req, projectId)) && !(await isMyTask(req.user!.id, taskId))) throw new HttpError(404, 'Task not found.');
    const { rows } = await db.query('SELECT * FROM milestone_updates WHERE task_id = $1 ORDER BY created_at DESC, id DESC', [taskId]);
    res.json(rows.map(mapMilestoneUpdate));
  }),
);

projectsRouter.delete(
  '/tasks/:taskId',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const projectId = await projectOfTask(taskId);
    await assertCanPlan(req, projectId);
    // A phase takes everything under it, and a milestone is a commitment the
    // weekly review tracks: removing either is the manager's or the PMO's call.
    const { rows: cur } = await db.query(
      `SELECT kind, name, code, (SELECT count(*) FROM tasks c WHERE c.parent_id = t.id) AS children FROM tasks t WHERE id = $1`,
      [taskId],
    );
    if (cur[0].kind === 'milestone' || cur[0].kind === 'summary' || cur[0].children > 0) {
      await assertCanGovern(req, projectId, cur[0].kind === 'milestone' ? 'milestones (delete)' : 'phases (delete)');
    }
    if (await isBaselined(db, projectId)) {
      // Removing a milestone (or a phase holding one) is a change of scope: a change request cancels it instead.
      const { rows: ms } = await db.query(
        `WITH sub AS (SELECT id, kind FROM tasks WHERE id = $1 UNION ALL SELECT t.id, t.kind FROM tasks t JOIN sub ON t.parent_id = sub.id)
         SELECT count(*) AS n FROM sub WHERE kind = 'milestone'`,
        [taskId],
      );
      if (ms[0].n > 0) throw lockedError('a milestone (removing it)');
    }
    await db.tx(async (q) => {
      const { rows } = await q.query(
        `DECLARE @gone TABLE (name NVARCHAR(MAX));
         DELETE FROM tasks OUTPUT DELETED.name INTO @gone WHERE id = $1;
         SELECT name FROM @gone`,
        [taskId],
      );
      await resync(q, projectId);
      await logActivity(q, projectId, req.user!.id, 'task.deleted', { name: rows[0]?.name, kind: cur[0].kind, code: cur[0].code });
    });
    res.json(await planOf(projectId));
  }),
);

projectsRouter.post(
  '/projects/:id/tasks/reorder',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanPlan(req, id);
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    await db.tx(async (q) => {
      let sort = 0;
      for (const taskId of ids) {
        await q.query('UPDATE tasks SET sort = $3 WHERE id = $1 AND project_id = $2', [taskId, id, (sort += 10)]);
      }
    });
    res.json(await planOf(id));
  }),
);

projectsRouter.post(
  '/projects/:id/dependencies',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanPlan(req, id);
    const predecessorId = int(req.body?.predecessorId, 'Predecessor');
    const successorId = int(req.body?.successorId, 'Successor');
    const lagDays = optInt(req.body?.lagDays, 'Lag', -365, 365) ?? 0;
    const { rows: owned } = await db.query('SELECT id FROM tasks WHERE project_id = $1 AND id IN (SELECT CAST(value AS INT) FROM OPENJSON($2))', [
      id,
      [predecessorId, successorId],
    ]);
    if (owned.length !== 2) throw new HttpError(400, 'Both tasks must belong to this project.');
    const { rows: existing } = await db.query('SELECT * FROM task_dependencies WHERE project_id = $1', [id]);
    if (createsCycle(existing.map(mapDependency), predecessorId, successorId)) {
      throw new HttpError(400, 'That link would make the tasks wait on each other in a loop.');
    }
    await db.tx(async (q) => {
      await q.query(
        `UPDATE task_dependencies SET lag_days = $4 WHERE predecessor_id = $2 AND successor_id = $3;
         IF @@ROWCOUNT = 0 INSERT INTO task_dependencies (project_id, predecessor_id, successor_id, lag_days) VALUES ($1,$2,$3,$4)`,
        [id, predecessorId, successorId, lagDays],
      );
      await pushSuccessors(q, id, predecessorId, 'a new link');
      await resync(q, id);
      await logActivity(q, id, req.user!.id, 'dependency.added', { predecessorId, successorId });
    });
    res.status(201).json(await planOf(id));
  }),
);

projectsRouter.delete(
  '/dependencies/:depId',
  route(async (req, res) => {
    const depId = idParam(req.params.depId);
    const { rows } = await db.query('SELECT project_id FROM task_dependencies WHERE id = $1', [depId]);
    if (!rows[0]) throw new HttpError(404, 'Link not found.');
    await assertCanPlan(req, rows[0].project_id);
    await db.query('DELETE FROM task_dependencies WHERE id = $1', [depId]);
    res.json(await planOf(rows[0].project_id));
  }),
);

// ---- Milestones across the portfolio -----------------------------------------

/** Every milestone the viewer may see, for the Milestones page and its filters. */
projectsRouter.get(
  '/milestones',
  route(async (req, res) => {
    const visibleTo = seesAllProjects(req) ? null : req.user!.id;
    const { rows } = await db.query(
      `SELECT t.id, t.project_id, t.code, t.name, t.end_date, t.baseline_end, t.status, t.progress,
              t.owner_name, t.co_owners, t.responsible_dept, t.escalate_to, t.blocker, t.last_update_on,
              t.update_comment, t.assignee_id, p.code AS project_code, p.name AS project_name,
              p.name_ar AS project_name_ar, p.department_id, p.health AS project_health,
              (SELECT CAST(min(e.raised_at) AT TIME ZONE 'Arab Standard Time' AS DATE) FROM escalations e WHERE e.task_id = t.id) AS escalated_on,
              (SELECT count(*) FROM escalations e WHERE e.task_id = t.id AND e.resolved_at IS NULL) AS open_escalations,
              (SELECT count(*) FROM deadline_changes c WHERE c.task_id = t.id AND c.status = 'pending') AS pending_changes
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.kind = 'milestone' AND p.archived = 0
          AND ${projectVisibleSql('p', '$1')} AND ${taskVisibleSql('t', 'p', '$1')}
        ORDER BY t.end_date, p.code, t.sort`,
      [visibleTo],
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectCode: r.project_code,
        projectName: r.project_name,
        projectNameAr: r.project_name_ar,
        departmentId: r.department_id,
        projectHealth: r.project_health,
        code: r.code,
        name: r.name,
        date: r.end_date,
        baselineDate: r.baseline_end,
        status: r.status,
        progress: r.progress,
        ownerName: r.owner_name,
        coOwners: r.co_owners,
        responsibleDept: r.responsible_dept,
        escalateTo: r.escalate_to,
        blocker: r.blocker,
        lastUpdateOn: r.last_update_on,
        updateComment: r.update_comment,
        assigneeId: r.assignee_id,
        escalatedOn: r.escalated_on ?? null,
        openEscalations: r.open_escalations,
        pendingChanges: r.pending_changes,
      })),
    );
  }),
);

// ---- Search -----------------------------------------------------------------
// Projects and milestones by name, code or owner, for the Ctrl+K box. Same visibility as the
// portfolio. Arabic letter forms are folded (أ إ آ -> ا, ة -> ه, ى -> ي) and case is ignored, so a
// name is found however it was typed.

const FOLD = (col: string) => `TRANSLATE(LOWER(${col}), N'أإآةى', N'اااهي')`;

projectsRouter.get(
  '/search',
  route(async (req, res) => {
    const raw = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (raw.length < 2) {
      res.json({ projects: [], milestones: [] });
      return;
    }
    const like = `%${raw.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\\%_[\]]/g, (c) => `\\${c}`)}%`;
    const visibleTo = seesAllProjects(req) ? null : req.user!.id;
    const scope = projectVisibleSql('p', '$2');
    const [projects, milestones] = await Promise.all([
      db.query(
        `SELECT TOP (6) p.id, p.code, p.name, p.name_ar, p.health, p.department_id, p.archived
           FROM projects p
          WHERE ${scope}
            AND (${FOLD('p.code')} LIKE $1 ESCAPE '\\' OR ${FOLD('p.name')} LIKE $1 ESCAPE '\\' OR ${FOLD("COALESCE(p.name_ar, '')")} LIKE $1 ESCAPE '\\')
          ORDER BY p.archived, CASE WHEN ${FOLD('p.code')} LIKE $1 ESCAPE '\\' THEN 0 ELSE 1 END, p.name`,
        [like, visibleTo],
      ),
      db.query(
        `SELECT TOP (10) t.id, t.project_id, t.code, t.name, t.end_date, t.status, t.owner_name, p.code AS project_code
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.kind = 'milestone' AND p.archived = 0 AND ${scope} AND ${taskVisibleSql('t', 'p', '$2')}
            AND (${FOLD('t.name')} LIKE $1 ESCAPE '\\' OR ${FOLD("COALESCE(t.code, '')")} LIKE $1 ESCAPE '\\' OR ${FOLD("COALESCE(t.owner_name, '')")} LIKE $1 ESCAPE '\\')
          ORDER BY CASE WHEN t.status IN ('done', 'cancelled') THEN 1 ELSE 0 END, t.end_date`,
        [like, visibleTo],
      ),
    ]);
    res.json({
      projects: projects.rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        nameAr: r.name_ar,
        health: r.health,
        departmentId: r.department_id,
        archived: r.archived,
      })),
      milestones: milestones.rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectCode: r.project_code,
        code: r.code,
        name: r.name,
        date: r.end_date,
        status: r.status,
        ownerName: r.owner_name,
      })),
    });
  }),
);

// ---- Weekly status updates --------------------------------------------------

projectsRouter.get(
  '/updates',
  route(async (req, res) => {
    const week = weekStart(date(req.query.week, 'Week'));
    // Same visibility as the portfolio: without view-all, only your own projects.
    const visibleTo = seesAllProjects(req) ? null : req.user!.id;
    const scope = `AND ($2 IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = u.project_id AND ${projectVisibleSql('p', '$2')}))`;
    const { rows } = await db.query(`SELECT u.* FROM status_updates u WHERE u.week_start = $1 ${scope}`, [week, visibleTo]);
    const ids = rows.map((r) => r.id);
    const notes = ids.length
      ? (await db.query('SELECT * FROM meeting_notes WHERE update_id IN (SELECT CAST(value AS INT) FROM OPENJSON($1)) ORDER BY created_at', [ids])).rows.map(
          mapNote,
        )
      : [];
    // Last week's updates: the trend, and the fallback a meeting shows for a
    // project whose manager has not filed yet.
    const prev = await db.query(`SELECT u.* FROM status_updates u WHERE u.week_start = $1 ${scope}`, [
      addDays(week, -7),
      visibleTo,
    ]);
    res.json({
      week,
      updates: rows.map((r) => mapUpdate(r, notes.filter((n) => n.updateId === r.id))),
      previous: prev.rows.map((r) => mapUpdate(r)),
    });
  }),
);

projectsRouter.put(
  '/projects/:id/updates/:week',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    if (!can(req, 'updates.write') && !can(req, 'projects.edit_all')) {
      throw new HttpError(403, 'Your role does not allow filing weekly updates.');
    }
    // The weekly update sets the project's health, so it is the manager's (or the PMO's) report.
    if (!(await canGovernProject(req, id))) throw new HttpError(403, 'Only the project manager or the PMO files the weekly update.');
    const week = weekStart(date(req.params.week, 'Week'));
    const b = req.body ?? {};
    const health = oneOf(b.health, 'Health', HEALTHS);
    assertMayFinish(req, 'health', health, null);
    const progress = int(b.progress, 'Progress', 0, 100);
    const { rows } = await db.tx(async (q) => {
      const result = await q.query(
        `UPDATE status_updates WITH (UPDLOCK, HOLDLOCK) SET
           health = $3, progress = $4, accomplishments = $5,
           next_steps = $6, blockers = $7, decisions = $8,
           author_id = $9, submitted_at = SYSDATETIMEOFFSET()
         WHERE project_id = $1 AND week_start = $2;
         IF @@ROWCOUNT = 0
           INSERT INTO status_updates (project_id, week_start, health, progress, accomplishments, next_steps, blockers, decisions, author_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);
         SELECT * FROM status_updates WHERE project_id = $1 AND week_start = $2`,
        [
          id,
          week,
          health,
          progress,
          optStr(b.accomplishments, 'Accomplishments') ?? '',
          optStr(b.nextSteps, 'Next steps') ?? '',
          optStr(b.blockers, 'Blockers') ?? '',
          optStr(b.decisions, 'Decisions needed') ?? '',
          req.user!.id,
        ],
      );
      // The newest update speaks for the project's health.
      await q.query(
        `UPDATE projects SET health = $2, updated_at = SYSDATETIMEOFFSET()
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM status_updates WHERE project_id = $1 AND week_start > $3)`,
        [id, health, week],
      );
      await logActivity(q, id, req.user!.id, 'update.submitted', { week, health, progress });
      return result;
    });
    res.json(mapUpdate(rows[0]));
  }),
);

projectsRouter.post(
  '/updates/:updateId/notes',
  route(async (req, res) => {
    const updateId = idParam(req.params.updateId);
    const kind = oneOf(req.body?.kind ?? 'comment', 'Kind', ['comment', 'decision', 'action'] as const);
    const { rows: u } = await db.query('SELECT project_id FROM status_updates WHERE id = $1', [updateId]);
    if (!u[0]) throw new HttpError(404, 'Update not found.');
    if (!can(req, 'meeting.run') && !(await canEditProject(req, u[0].project_id))) {
      throw new HttpError(403, 'Only people running the review or this project team can add notes.');
    }
    const { rows } = await db.query(
      'INSERT INTO meeting_notes (update_id, kind, body, author_id) OUTPUT INSERTED.* VALUES ($1,$2,$3,$4)',
      [updateId, kind, str(req.body?.body, 'Note', 2000), req.user!.id],
    );
    await logActivity(db, u[0].project_id, req.user!.id, `note.${kind}`, { body: rows[0].body });
    res.status(201).json(mapNote(rows[0]));
  }),
);

projectsRouter.delete(
  '/notes/:noteId',
  route(async (req, res) => {
    const noteId = idParam(req.params.noteId);
    const { rows } = await db.query('SELECT author_id FROM meeting_notes WHERE id = $1', [noteId]);
    if (!rows[0]) throw new HttpError(404, 'Note not found.');
    if (rows[0].author_id !== req.user!.id && !can(req, 'meeting.run')) {
      throw new HttpError(403, 'Only the author or the PMO can remove a note.');
    }
    await db.query('DELETE FROM meeting_notes WHERE id = $1', [noteId]);
    res.json({ ok: true });
  }),
);

// ---- Risks and issues -------------------------------------------------------

const LEVELS = ['low', 'medium', 'high'] as const;

projectsRouter.post(
  '/projects/:id/risks',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanEdit(req, id);
    const b = req.body ?? {};
    const { rows } = await db.query(
      `INSERT INTO risks (project_id, kind, title, impact, likelihood, owner_id, mitigation, due_date)
       OUTPUT INSERTED.* VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        oneOf(b.kind ?? 'risk', 'Kind', ['risk', 'issue'] as const),
        str(b.title, 'Title', 240),
        oneOf(b.impact ?? 'medium', 'Impact', LEVELS),
        oneOf(b.likelihood ?? 'medium', 'Likelihood', LEVELS),
        optInt(b.ownerId, 'Owner'),
        optStr(b.mitigation, 'Mitigation'),
        optDate(b.dueDate, 'Due date'),
      ],
    );
    await logActivity(db, id, req.user!.id, `${rows[0].kind}.raised`, { title: rows[0].title });
    res.status(201).json(mapRisk(rows[0]));
  }),
);

projectsRouter.patch(
  '/risks/:riskId',
  route(async (req, res) => {
    const riskId = idParam(req.params.riskId);
    const { rows: cur } = await db.query('SELECT project_id FROM risks WHERE id = $1', [riskId]);
    if (!cur[0]) throw new HttpError(404, 'Not found.');
    await assertCanEdit(req, cur[0].project_id);
    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [riskId];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if ('title' in b) set('title', str(b.title, 'Title', 240));
    if ('kind' in b) set('kind', oneOf(b.kind, 'Kind', ['risk', 'issue'] as const));
    if ('impact' in b) set('impact', oneOf(b.impact, 'Impact', LEVELS));
    if ('likelihood' in b) set('likelihood', oneOf(b.likelihood, 'Likelihood', LEVELS));
    if ('status' in b) set('status', oneOf(b.status, 'Status', ['open', 'mitigating', 'closed'] as const));
    if ('ownerId' in b) set('owner_id', optInt(b.ownerId, 'Owner'));
    if ('mitigation' in b) set('mitigation', optStr(b.mitigation, 'Mitigation'));
    if ('dueDate' in b) set('due_date', optDate(b.dueDate, 'Due date'));
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    const { rows } = await db.query(`UPDATE risks SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE id = $1`, vals);
    res.json(mapRisk(rows[0]));
  }),
);

projectsRouter.delete(
  '/risks/:riskId',
  route(async (req, res) => {
    const riskId = idParam(req.params.riskId);
    const { rows } = await db.query('SELECT project_id FROM risks WHERE id = $1', [riskId]);
    if (!rows[0]) throw new HttpError(404, 'Not found.');
    await assertCanEdit(req, rows[0].project_id);
    await db.query('DELETE FROM risks WHERE id = $1', [riskId]);
    res.json({ ok: true });
  }),
);
