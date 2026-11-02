import { Router } from 'express';
import { db } from '../db';
import { HttpError, can, canGovernProject, canViewProject, requirePermission, route } from '../auth';
import { closers, notify } from '../notify';
import { logActivity } from '../service';
import { idParam, oneOf, optStr } from '../validate';
import { TEMPLATES, cleanDelivery } from '../delivery';
import path from 'node:path';
import fs from 'node:fs';

// Closing a project. Nobody marks one finished alone: its owner (or its department head) asks, and a PMO
// admin (whoever holds "Approve project closure") decides. Approval is what sets the project to Closed.
export const closureRouter = Router();

/** Everything waiting for a decision, for the people who decide. */
closureRouter.get(
  '/closure-requests/pending',
  requirePermission('projects.approve_close'),
  route(async (_req, res) => {
    const { rows } = await db.query(
      `SELECT c.id, c.note, c.created_at, c.project_id, c.delivery_url, c.delivery_file_name, c.report_file_name, c.checklist_file_name, p.code, p.name, p.name_ar, p.progress, p.stage, p.health,
              u.name AS requested_by_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.kind = 'milestone'
                 AND t.status NOT IN ('done', 'cancelled')) AS open_milestones
         FROM closure_requests c JOIN projects p ON p.id = c.project_id LEFT JOIN users u ON u.id = c.requested_by
        WHERE c.status = 'pending' ORDER BY c.created_at`,
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectCode: r.code,
        projectName: r.name,
        projectNameAr: r.name_ar,
        progress: r.progress,
        openMilestones: r.open_milestones,
        note: r.note,
        deliveryUrl: r.delivery_url ?? null,
        deliveryFileName: r.delivery_file_name ?? null,
        reportFileName: r.report_file_name ?? null,
        checklistFileName: r.checklist_file_name ?? null,
        requestedByName: r.requested_by_name,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    );
  }),
);

/** The project's owner, its department head or the PMO asks to close it. */
closureRouter.post(
  '/projects/:id/closure-request',
  route(async (req, res) => {
    const projectId = idParam(req.params.id);
    if (!(await canViewProject(req, projectId))) throw new HttpError(404, 'Project not found.');
    if (!(await canGovernProject(req, projectId))) {
      throw new HttpError(403, 'Only the project owner, the head of its department or the PMO can ask to close a project.');
    }
    const { rows: pr } = await db.query('SELECT name, stage FROM projects WHERE id = $1', [projectId]);
    if (pr[0].stage === 'closed') throw new HttpError(409, 'This project is already closed.');
    if (can(req, 'projects.approve_close')) {
      throw new HttpError(400, 'You can approve closures yourself: set the stage to Closed on the project, no request is needed.');
    }
    const note = optStr(req.body?.note, 'Note', 1000) ?? '';
    // A project does not finish without its closure report and its signed sign-off checklist.
    const delivery = cleanDelivery(req.body);
    let created;
    try {
      created = await db.query(
        `INSERT INTO closure_requests (project_id, requested_by, note, delivery_url, delivery_file_name, delivery_file_type, delivery_file,
            report_file_name, report_file_type, report_file, checklist_file_name, checklist_file_type, checklist_file)
         OUTPUT INSERTED.id
         VALUES ($1, $2, $3, $4, $5, $6, CAST($7 AS VARBINARY(MAX)), $8, $9, CAST($10 AS VARBINARY(MAX)), $11, $12, CAST($13 AS VARBINARY(MAX)))`,
        [
          projectId, req.user!.id, note, delivery.url, delivery.file?.name ?? null, delivery.file?.type ?? null, delivery.file?.data ?? null,
          delivery.report.name, delivery.report.type, delivery.report.data, delivery.checklist.name, delivery.checklist.type, delivery.checklist.data,
        ],
      );
    } catch (e) {
      if (/closure_one_pending_idx|unique/i.test((e as Error).message)) throw new HttpError(409, 'A request to close this project is already waiting for the PMO.');
      throw e;
    }
    await logActivity(db, projectId, req.user!.id, 'closure.requested', { name: pr[0].name, note, deliveryUrl: delivery.url, deliveryFile: delivery.file?.name ?? null, report: delivery.report.name, checklist: delivery.checklist.name });
    await notify(db, await closers(db), { kind: 'closure.requested', projectId, data: { name: pr[0].name, by: req.user!.name, note, delivery: [delivery.report.name, delivery.checklist.name, delivery.url ?? delivery.file?.name].filter(Boolean).join(', ') } }, req.user!.id);
    res.status(201).json({ id: created.rows[0].id });
  }),
);

/**
 * A document of a closure request (?kind=report, checklist or delivery, the default): for whoever can see the project,
 * always as a download.
 */
closureRouter.get(
  '/closure-requests/:id/document',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const kind = oneOf(req.query.kind ?? 'delivery', 'Document', ['delivery', 'report', 'checklist'] as const);
    const { rows } = await db.query(`SELECT project_id, ${kind}_file_name AS name, ${kind}_file_type AS type, ${kind}_file AS data FROM closure_requests WHERE id = $1`, [id]);
    const c = rows[0];
    if (!c?.data || !(await canViewProject(req, c.project_id))) throw new HttpError(404, 'Document not found.');
    res.setHeader('Content-Type', c.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(c.name).replace(/[^A-Za-z0-9._ -]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(c.data));
  }),
);

/** The templates of the closure documents, to download, fill in and attach. Any signed-in person. */
closureRouter.get(
  '/templates/:name',
  route(async (req, res) => {
    const t = TEMPLATES[String(req.params.name)];
    if (!t) throw new HttpError(404, 'Template not found.');
    const file = path.resolve(__dirname, '..', 'templates', t.file);
    const fallback = path.resolve(__dirname, '..', '..', '..', 'server', 'templates', t.file);
    const where = fs.existsSync(file) ? file : fallback;
    if (!fs.existsSync(where)) throw new HttpError(404, 'Template not found.');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${t.name}"`);
    res.sendFile(where);
  }),
);

/** A PMO admin approves (the project becomes Closed) or rejects (it carries on). Not their own request. */
closureRouter.post(
  '/closure-requests/:id/decide',
  requirePermission('projects.approve_close'),
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const decision = oneOf(req.body?.decision, 'Decision', ['approve', 'reject'] as const);
    const decisionNote = optStr(req.body?.note, 'Note', 1000);
    const { rows } = await db.query('SELECT c.*, p.name AS project_name FROM closure_requests c JOIN projects p ON p.id = c.project_id WHERE c.id = $1', [id]);
    const c = rows[0];
    if (!c) throw new HttpError(404, 'Request not found.');
    if (c.status !== 'pending') throw new HttpError(409, 'This request was already decided.');
    if (c.requested_by === req.user!.id) throw new HttpError(403, 'You cannot decide on your own request.');
    await db.tx(async (q) => {
      await q.query(
        `UPDATE closure_requests SET status = $2, decided_by = $3, decided_at = SYSDATETIMEOFFSET(), decision_note = $4 WHERE id = $1`,
        [id, decision === 'approve' ? 'approved' : 'rejected', req.user!.id, decisionNote],
      );
      if (decision === 'approve') {
        await q.query(`UPDATE projects SET stage = 'closed', health = 'done', updated_at = SYSDATETIMEOFFSET() WHERE id = $1`, [c.project_id]);
      }
      await logActivity(q, c.project_id, req.user!.id, decision === 'approve' ? 'closure.approved' : 'closure.rejected', {
        name: c.project_name,
        note: decisionNote,
      });
    });
    await notify(db, [c.requested_by], {
      kind: 'closure.decided',
      projectId: c.project_id,
      data: { name: c.project_name, decision, by: req.user!.name, note: decisionNote },
    }, req.user!.id);
    res.json({ ok: true });
  }),
);
