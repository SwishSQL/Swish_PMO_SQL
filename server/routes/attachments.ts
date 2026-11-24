import { Router } from 'express';
import type { Request } from 'express';
import { db } from '../db';
import { HttpError, canEditProject, canGovernProject, canViewProject, isMyTask, route, seesWholePlan } from '../auth';
import { logActivity } from '../service';
import { idParam } from '../validate';

// Files attached to a milestone or task. Any kind of file, up to 8 MB, kept in the database. A file is always served
// as a download of a neutral type, never shown inside the system, so an uploaded page or script cannot run in it.

export const attachmentsRouter = Router();
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

async function taskProject(taskId: number): Promise<number> {
  const { rows } = await db.query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
  if (!rows[0]) throw new HttpError(404, 'Task not found.');
  return rows[0].project_id;
}

/** Whoever may read the task's history: those who see the whole plan, and those it is given to. */
async function assertCanSee(req: Request, taskId: number, projectId: number): Promise<void> {
  if (!(await canViewProject(req, projectId))) throw new HttpError(404, 'Task not found.');
  if (!(await seesWholePlan(req, projectId)) && !(await isMyTask(req.user!.id, taskId))) throw new HttpError(404, 'Task not found.');
}

const mapAttachment = (r: any) => ({ id: r.id, taskId: r.task_id, name: r.name, size: r.size, uploadedBy: r.uploaded_by ?? null, uploadedByName: r.uploader ?? null, createdAt: r.created_at });

attachmentsRouter.get(
  '/tasks/:taskId/attachments',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const projectId = await taskProject(taskId);
    await assertCanSee(req, taskId, projectId);
    const { rows } = await db.query(
      `SELECT a.id, a.task_id, a.name, a.size, a.uploaded_by, a.created_at, u.name AS uploader
         FROM task_attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.task_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
      [taskId],
    );
    res.json(rows.map(mapAttachment));
  }),
);

/** Attach a file ({ name, data: base64 }): the task's owners, the project owner, the department head and the PMO. */
attachmentsRouter.post(
  '/tasks/:taskId/attachments',
  route(async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const projectId = await taskProject(taskId);
    const mayAttach = (await canEditProject(req, projectId)) && ((await canGovernProject(req, projectId)) || (await isMyTask(req.user!.id, taskId)));
    if (!mayAttach) throw new HttpError(403, 'Only the owners of this task, the project manager and the PMO attach files to it.');
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/[\\/\r\n"]/g, '_').slice(0, 160) : '';
    if (!name) throw new HttpError(400, 'The file has no name.');
    if (typeof req.body?.data !== 'string') throw new HttpError(400, 'The file did not arrive.');
    const data = Buffer.from(req.body.data, 'base64');
    if (data.length === 0) throw new HttpError(400, 'The file is empty.');
    if (data.length > MAX_ATTACHMENT_BYTES) throw new HttpError(400, 'The file is larger than 8 MB. Make it smaller (or zip it) and try again.');
    const { rows } = await db.query(
      'INSERT INTO task_attachments (task_id, name, size, data, uploaded_by) OUTPUT INSERTED.id, INSERTED.task_id, INSERTED.name, INSERTED.size, INSERTED.uploaded_by, INSERTED.created_at VALUES ($1, $2, $3, CAST($4 AS VARBINARY(MAX)), $5)',
      [taskId, name, data.length, data, req.user!.id],
    );
    await logActivity(db, projectId, req.user!.id, 'task.attachment_added', { taskId, name, size: data.length });
    res.status(201).json(mapAttachment({ ...rows[0], uploader: req.user!.name }));
  }),
);

/** The file, always as a download. */
attachmentsRouter.get(
  '/attachments/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const { rows } = await db.query('SELECT task_id, name, data FROM task_attachments WHERE id = $1', [id]);
    const a = rows[0];
    if (!a) throw new HttpError(404, 'File not found.');
    await assertCanSee(req, a.task_id, await taskProject(a.task_id));
    const ascii = String(a.name).replace(/[^A-Za-z0-9._ -]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(a.data));
  }),
);

/** Removed by whoever attached it, the project owner, the department head or the PMO. */
attachmentsRouter.delete(
  '/attachments/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const { rows } = await db.query('SELECT task_id, name, uploaded_by FROM task_attachments WHERE id = $1', [id]);
    const a = rows[0];
    if (!a) throw new HttpError(404, 'File not found.');
    const projectId = await taskProject(a.task_id);
    const mine = a.uploaded_by === req.user!.id && (await canEditProject(req, projectId));
    if (!mine && !(await canGovernProject(req, projectId))) throw new HttpError(403, 'Only whoever attached this file, the project manager and the PMO remove it.');
    await db.query('DELETE FROM task_attachments WHERE id = $1', [id]);
    await logActivity(db, projectId, req.user!.id, 'task.attachment_removed', { taskId: a.task_id, name: a.name });
    res.json({ ok: true });
  }),
);
