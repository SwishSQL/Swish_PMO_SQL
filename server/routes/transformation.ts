import { Router } from 'express';
import { db } from '../db';
import { HttpError, can, canManageAccounts, route, seesAllProjects } from '../auth';
import { listProjects, logActivity } from '../service';
import { importPlan, loadPlan, planLinks, readPlanWorkbook } from '../transformation';
import { planScope } from '../planScope';
import { notify } from '../notify';

// The transformation plan on the Portfolio: Capability > Dimension > plan project > the system's projects.
export const transformationRouter = Router();

const pmoOnly = (req: Parameters<typeof can>[0]) => {
  if (!can(req, 'projects.edit_all')) throw new HttpError(403, 'Only the PMO keeps the transformation plan and its links.');
};

/** The plan, with the projects this person can see under each plan project. */
transformationRouter.get(
  '/transformation',
  route(async (req, res) => {
    // The system admins, the PMO and the department heads; everyone else gets an empty plan.
    const heads = (await db.query('SELECT TOP (1) 1 AS x FROM departments WHERE head_user_id = $1', [req.user!.id])).rows.length > 0;
    const manages = (await db.query('SELECT TOP (1) 1 AS x FROM (SELECT 1 AS x FROM capabilities WHERE manager_user_id = $1 UNION ALL SELECT 1 FROM dimensions WHERE manager_user_id = $1) m', [req.user!.id])).rows.length > 0;
    // A project manager sees the plan projects nobody has started yet, to start one (and those of their projects).
    const starts = can(req, 'projects.start_plan');
    if (!canManageAccounts(req) && !can(req, 'projects.edit_all') && !heads && !manages && !starts) return void res.json([]);
    const visible = seesAllProjects(req) ? null : new Set((await listProjects(null, req.user!.id)).map((p) => p.id));
    const plan = await loadPlan(visible);
    // Outside the PMO: only the plan projects of their portfolios, programs and department.
    const scope = await planScope(req);
    if (!scope) return void res.json(plan);
    if (starts) {
      const { rows } = await db.query('SELECT i.id FROM initiatives i WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.initiative_id = i.id AND p.archived = 0)');
      for (const r of rows) scope.add(r.id);
    }
    res.json(
      plan
        .map((c) => ({ ...c, dimensions: c.dimensions.map((d) => ({ ...d, initiatives: d.initiatives.filter((i) => scope.has(i.id)) })).filter((d) => d.initiatives.length > 0) }))
        .filter((c) => c.dimensions.length > 0),
    );
  }),
);

/** The plan projects nobody has started yet, for a project manager to start one: with their portfolio and program. */
transformationRouter.get(
  '/transformation/open',
  route(async (req, res) => {
    if (!can(req, 'projects.start_plan') && !can(req, 'projects.edit_all')) return void res.json([]);
    const plan = await loadPlan(null);
    res.json(
      plan.flatMap((c) =>
        c.dimensions.flatMap((d) => d.initiatives.filter((i) => i.projectIds.length === 0).map((i) => ({ ...i, portfolio: c.name, program: d.name }))),
      ),
    );
  }),
);

/** The PMO names the manager of a portfolio (capability) or a program (dimension). */
transformationRouter.put(
  '/transformation/manager',
  route(async (req, res) => {
    pmoOnly(req);
    const kind = req.body?.kind === 'capability' ? 'capabilities' : req.body?.kind === 'dimension' ? 'dimensions' : null;
    if (!kind) throw new HttpError(400, 'Say whether it is a portfolio or a program.');
    const id = Number(req.body?.id);
    const userId = req.body?.userId ? Number(req.body.userId) : null;
    if (userId) {
      const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND active = 1', [userId]);
      if (!rows.length) throw new HttpError(400, 'Choose an active person.');
    }
    const r = await db.query(`UPDATE ${kind} SET manager_user_id = $2 WHERE id = $1`, [id, userId]);
    if (!(r as any).rowCount) throw new HttpError(404, 'Not found.');
    await logActivity(db, null, req.user!.id, 'plan.manager_set', { kind, id, userId });
    if (userId) {
      const { rows: nm } = await db.query(`SELECT name FROM ${kind} WHERE id = $1`, [id]);
      await notify(db, [userId], { kind: 'plan.manager', data: { name: nm[0]?.name ?? '', role: kind === 'capabilities' ? 'portfolio' : 'program', by: req.user!.name } }, req.user!.id);
    }
    res.json({ ok: true });
  }),
);

/** The named top steps of the escalation ladder (IBE and CEO): read by the PMO, set by the PMO. */
transformationRouter.get(
  '/ladder-roles',
  route(async (req, res) => {
    pmoOnly(req);
    const { rows } = await db.query('SELECT [key], user_id FROM ladder_roles');
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.user_id])));
  }),
);
transformationRouter.put(
  '/ladder-roles',
  route(async (req, res) => {
    pmoOnly(req);
    for (const key of ['ibe', 'ceo']) {
      if (!(key in (req.body ?? {}))) continue;
      const userId = req.body[key] ? Number(req.body[key]) : null;
      const { rows: was } = await db.query('SELECT user_id FROM ladder_roles WHERE [key] = $1', [key]);
      await db.query(
        `UPDATE ladder_roles SET user_id = $2 WHERE [key] = $1;
         IF @@ROWCOUNT = 0 INSERT INTO ladder_roles ([key], user_id) VALUES ($1, $2)`,
        [key, userId],
      );
      if (userId && was[0]?.user_id !== userId) await notify(db, [userId], { kind: 'ladder.role', data: { role: key, by: req.user!.name } }, req.user!.id);
    }
    await logActivity(db, null, req.user!.id, 'ladder.roles_set', req.body ?? {});
    const { rows } = await db.query('SELECT [key], user_id FROM ladder_roles');
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.user_id])));
  }),
);

/** Every project with its link and the suggested one, for the PMO to review. */
transformationRouter.get(
  '/transformation/links',
  route(async (req, res) => {
    pmoOnly(req);
    res.json(await planLinks());
  }),
);

/** Sets (or clears) the plan project of projects: { links: [{ projectId, initiativeId | null }] }. */
transformationRouter.post(
  '/transformation/links',
  route(async (req, res) => {
    pmoOnly(req);
    const links: unknown = req.body?.links;
    if (!Array.isArray(links) || links.length > 2000) throw new HttpError(400, 'Send the links to save.');
    let saved = 0;
    await db.tx(async (q) => {
      for (const l of links as { projectId: unknown; initiativeId: unknown }[]) {
        const projectId = Number(l?.projectId);
        const initiativeId = l?.initiativeId === null || l?.initiativeId === '' ? null : Number(l?.initiativeId);
        if (!Number.isInteger(projectId) || (initiativeId !== null && !Number.isInteger(initiativeId))) throw new HttpError(400, 'A link is not valid.');
        if (initiativeId !== null) {
          const { rows } = await q.query('SELECT 1 FROM initiatives WHERE id = $1', [initiativeId]);
          if (!rows[0]) throw new HttpError(400, 'A plan project in the links does not exist.');
        }
        const { rowCount } = await q.query(
          'UPDATE projects SET initiative_id = $2 WHERE id = $1 AND (initiative_id <> $2 OR (initiative_id IS NULL AND $2 IS NOT NULL) OR (initiative_id IS NOT NULL AND $2 IS NULL))',
          [projectId, initiativeId],
        );
        if (rowCount > 0) {
          saved += 1;
          await logActivity(q, projectId, req.user!.id, 'project.plan_linked', { initiativeId });
        }
      }
    });
    res.json({ saved });
  }),
);

/** A new version of the Transformation Capabilities workbook (base64 .xlsx): its rows update the plan. */
transformationRouter.post(
  '/transformation/import',
  route(async (req, res) => {
    pmoOnly(req);
    const data = typeof req.body?.data === 'string' ? Buffer.from(req.body.data, 'base64') : null;
    if (!data?.length) throw new HttpError(400, 'Attach the workbook.');
    const rows = await readPlanWorkbook(data);
    const result = await db.tx((q) => importPlan(q, rows));
    await logActivity(db, null, req.user!.id, 'plan.imported', { ...result, file: String(req.body?.name ?? '').slice(0, 160) });
    res.json(result);
  }),
);
