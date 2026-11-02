import { Router } from 'express';
import { db } from '../db';
import { HttpError, can, route } from '../auth';
import { logActivity } from '../service';
import { readTracker, runTracker } from '../trackerUpdate';

// The Milestones Tracker: the PMO uploads the workbook, sees what it would change, then applies it.
export const trackerRouter = Router();

async function parsed(req: Parameters<typeof can>[0] & { body?: any }) {
  if (!can(req, 'projects.edit_all')) throw new HttpError(403, 'Only the PMO updates the projects from the tracker.');
  const data = typeof req.body?.data === 'string' ? Buffer.from(req.body.data, 'base64') : null;
  if (!data?.length) throw new HttpError(400, 'Attach the workbook.');
  return readTracker(data);
}

/** What the workbook would change. Nothing is written. */
trackerRouter.post(
  '/tracker/preview',
  route(async (req, res) => {
    const file = await parsed(req);
    res.json(await db.tx((q) => runTracker(q, file, false, req.user!.id)));
  }),
);

/** Applies it, in one transaction: either everything is written or nothing. */
trackerRouter.post(
  '/tracker/apply',
  route(async (req, res) => {
    const file = await parsed(req);
    const plan = await db.tx((q) => runTracker(q, file, true, req.user!.id));
    await logActivity(db, null, req.user!.id, 'tracker.applied', {
      file: String(req.body?.name ?? '').slice(0, 160),
      updated: plan.updated.reduce((n, p) => n + p.changes.length, 0),
      created: plan.created.map((c) => c.code),
      filled: plan.filled.map((c) => c.code),
    });
    res.json(plan);
  }),
);
