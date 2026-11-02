import { Router } from 'express';
import { db } from '../db';
import { HttpError, can, route, seesAllProjects } from '../auth';
import { listProjects, logActivity } from '../service';
import { importPlan, loadPlan, planLinks, readPlanWorkbook } from '../transformation';

// The transformation plan on the Portfolio: Capability > Dimension > plan project > the system's projects.
export const transformationRouter = Router();

const pmoOnly = (req: Parameters<typeof can>[0]) => {
  if (!can(req, 'projects.edit_all')) throw new HttpError(403, 'Only the PMO keeps the transformation plan and its links.');
};

/** The plan, with the projects this person can see under each plan project. */
transformationRouter.get(
  '/transformation',
  route(async (req, res) => {
    const visible = seesAllProjects(req) ? null : new Set((await listProjects(null, req.user!.id)).map((p) => p.id));
    res.json(await loadPlan(visible));
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
