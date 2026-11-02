import { Router } from 'express';
import { db } from '../db';
import { HttpError, can, canEditProject, canGovernProject, canViewProject, route } from '../auth';
import { logActivity } from '../service';
import { notify } from '../notify';
import { idParam, oneOf, optDate, optStr, str } from '../validate';
import { CHANGE_SELECT, applyChange, changeApprovers, cleanChanges, headOf, loadChange, mapChange, nextSeq } from '../changes';
import { todayIso } from '../../shared/dates';
import type { ChangeArea } from '../../shared/types';

// The change process, step by step: anyone on the project asks (the change request form), the head of the
// project's department approves, the PMO gives the final approval, and the system applies the change. Each
// request stays in the project's change log.
export const changesRouter = Router();

const AREAS: ChangeArea[] = ['scope', 'cost', 'schedule'];

/** The project's change log, newest first. Whoever can see the project can read it. */
changesRouter.get(
  '/projects/:id/changes',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await canViewProject(req, id))) throw new HttpError(404, 'Project not found.');
    const { rows } = await db.query(`${CHANGE_SELECT} WHERE c.project_id = $1 ORDER BY c.seq DESC`, [id]);
    res.json(rows.map(mapChange));
  }),
);

/** A new change request (the form). Anyone on the project team may ask. */
changesRouter.post(
  '/projects/:id/changes',
  route(async (req, res) => {
    const projectId = idParam(req.params.id);
    if (!(await canViewProject(req, projectId))) throw new HttpError(404, 'Project not found.');
    if (!(await canEditProject(req, projectId))) throw new HttpError(403, 'Only the project team and the PMO can ask for a change to this project.');
    const b = req.body ?? {};
    const description = str(b.description, 'Request description', 4000).trim();
    const reason = str(b.reason, 'Reasons for the change', 4000).trim();
    if (description.length < 3) throw new HttpError(400, 'Describe the change.');
    if (reason.length < 3) throw new HttpError(400, 'Give the reasons for the change.');
    const actions = (optStr(b.actions, 'Actions to implement the change', 4000) ?? '').trim();
    const actionsDate = optDate(b.actionsDate, 'Date of the actions');
    const { changes, snapshot, areas } = await cleanChanges(db, projectId, b.changes ?? {});
    // The areas ticked on the form, and those the proposed values touch.
    const ticked = Array.isArray(b.areas) ? AREAS.filter((a) => b.areas.includes(a)) : [];
    const allAreas = AREAS.filter((a) => ticked.includes(a) || areas.includes(a));
    if (!allAreas.length) throw new HttpError(400, 'Say what the change touches: scope, cost or schedule.');

    // The head of the department approves first, unless they asked themselves or the department has none.
    const head = await headOf(db, projectId);
    const skipped = !head ? 'The department has no head.' : head === req.user!.id ? 'Asked by the head of the department.' : null;
    const created = await db.tx(async (q) => {
      const seq = await nextSeq(q, projectId);
      const { rows } = await q.query(
        `INSERT INTO change_requests (project_id, seq, requested_by, areas, description, reason, actions, actions_date, changes, snapshot, stage, head_skipped)
         OUTPUT INSERTED.id
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [projectId, seq, req.user!.id, JSON.stringify(allAreas), description, reason, actions, actionsDate, JSON.stringify(changes), JSON.stringify(snapshot), skipped ? 'pmo' : 'head', skipped],
      );
      await logActivity(q, projectId, req.user!.id, 'change.requested', { code: `CR-${String(seq).padStart(3, '0')}`, description, areas: allAreas });
      return rows[0].id as number;
    });
    const cr = (await loadChange(db, created))!;
    const { rows: pr } = await db.query('SELECT name FROM projects WHERE id = $1', [projectId]);
    const to = skipped ? await changeApprovers(db) : [head];
    await notify(db, to, { kind: 'change.pending', projectId, data: { code: cr.code, name: description, project: pr[0]?.name, by: req.user!.name, reason, stage: cr.stage } }, req.user!.id);
    res.status(201).json(cr);
  }),
);

/**
 * A decision on a request: approve, reject (with the reason), put on hold, or take off hold. The head of the
 * department decides at the first step, a PMO approver at the second. Nobody decides on their own request.
 * The PMO's approval applies the change.
 */
changesRouter.post(
  '/changes/:id/decide',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const cr = await loadChange(db, id);
    if (!cr) throw new HttpError(404, 'Change request not found.');
    const decision = oneOf(req.body?.decision, 'Decision', ['approve', 'reject', 'hold', 'resume'] as const);
    const note = (optStr(req.body?.note, 'Note', 2000) ?? '').trim() || null;
    if (cr.status !== 'pending' && cr.status !== 'on_hold') throw new HttpError(409, 'This request was already decided.');
    if (decision === 'resume' ? cr.status !== 'on_hold' : cr.status === 'on_hold' && decision === 'hold') throw new HttpError(409, decision === 'resume' ? 'This request is not on hold.' : 'This request is already on hold.');
    if (cr.requestedBy === req.user!.id) throw new HttpError(403, 'You cannot decide on your own request.');
    if (cr.stage === 'head') {
      if ((await headOf(db, cr.projectId)) !== req.user!.id) throw new HttpError(403, 'The head of the project\'s department decides at this step.');
    } else if (!can(req, 'changes.approve')) {
      throw new HttpError(403, 'Only the PMO gives the final approval of a change.');
    }
    if (decision === 'reject' && (!note || note.length < 3)) throw new HttpError(400, 'Give the reason for rejecting it.');

    let final = false;
    await db.tx(async (q) => {
      if (decision === 'hold' || decision === 'resume') {
        await q.query('UPDATE change_requests SET status = $2 WHERE id = $1', [id, decision === 'hold' ? 'on_hold' : 'pending']);
      } else if (decision === 'reject') {
        final = true;
        await q.query(
          `UPDATE change_requests SET status = 'rejected', decided_by = $2, decided_at = SYSDATETIMEOFFSET(), decision_note = $3 WHERE id = $1`,
          [id, req.user!.id, note],
        );
      } else if (cr.stage === 'head') {
        await q.query(`UPDATE change_requests SET stage = 'pmo', status = 'pending', head_by = $2, head_at = SYSDATETIMEOFFSET(), head_note = $3 WHERE id = $1`, [id, req.user!.id, note]);
      } else {
        final = true;
        const applied = await applyChange(q, cr.projectId, cr, req.user!.id);
        await q.query(
          `UPDATE change_requests SET status = 'approved', decided_by = $2, decided_at = SYSDATETIMEOFFSET(), decision_note = $3, applied = $4,
                  completion_date = COALESCE(completion_date, $5) WHERE id = $1`,
          [id, req.user!.id, note, JSON.stringify(applied), todayIso()],
        );
      }
      await logActivity(q, cr.projectId, req.user!.id, `change.${decision === 'approve' ? (cr.stage === 'head' ? 'head_approved' : 'approved') : decision === 'reject' ? 'rejected' : decision === 'hold' ? 'on_hold' : 'resumed'}`, {
        code: cr.code,
        note,
      });
    });
    const { rows: pr } = await db.query('SELECT name, manager_id FROM projects WHERE id = $1', [cr.projectId]);
    if (decision === 'approve' && cr.stage === 'head') {
      await notify(db, await changeApprovers(db), { kind: 'change.pending', projectId: cr.projectId, data: { code: cr.code, name: cr.description, project: pr[0]?.name, by: cr.requestedByName, reason: cr.reason, stage: 'pmo' } }, req.user!.id);
    } else if (final) {
      await notify(db, [cr.requestedBy, pr[0]?.manager_id], { kind: 'change.decided', projectId: cr.projectId, data: { code: cr.code, name: cr.description, project: pr[0]?.name, decision, by: req.user!.name, note } }, req.user!.id);
    }
    res.json(await loadChange(db, id));
  }),
);

/** The person who asked takes the request back, while nobody has decided on it. */
changesRouter.post(
  '/changes/:id/withdraw',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const cr = await loadChange(db, id);
    if (!cr) throw new HttpError(404, 'Change request not found.');
    if (cr.requestedBy !== req.user!.id) throw new HttpError(403, 'Only the person who asked can withdraw a request.');
    if (cr.status !== 'pending' && cr.status !== 'on_hold') throw new HttpError(409, 'This request was already decided.');
    await db.query(`UPDATE change_requests SET status = 'withdrawn' WHERE id = $1`, [id]);
    await logActivity(db, cr.projectId, req.user!.id, 'change.withdrawn', { code: cr.code });
    res.json(await loadChange(db, id));
  }),
);

/** The PMO removes a request that was never approved (a test, a duplicate). An approved one applied changes and stays in the log. */
changesRouter.delete(
  '/changes/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const cr = await loadChange(db, id);
    if (!cr) throw new HttpError(404, 'Change request not found.');
    if (!can(req, 'changes.approve')) throw new HttpError(403, 'Only the PMO removes a change request.');
    if (cr.status === 'approved') throw new HttpError(409, 'An approved change request stays in the change log.');
    await db.query('DELETE FROM change_requests WHERE id = $1', [id]);
    await logActivity(db, cr.projectId, req.user!.id, 'change.deleted', { code: cr.code, description: cr.description });
    res.json({ ok: true });
  }),
);

/** The change log's follow-up columns: progress, completion / launch date, notes. The project owner, head or PMO. */
changesRouter.patch(
  '/changes/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const cr = await loadChange(db, id);
    if (!cr) throw new HttpError(404, 'Change request not found.');
    if (!(await canGovernProject(req, cr.projectId))) throw new HttpError(403, 'Only the project owner, the head of its department or the PMO keeps the change log.');
    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => (vals.push(v), sets.push(`${col} = $${vals.length}`));
    if ('progress' in b) set('progress', (optStr(b.progress, 'Progress', 4000) ?? '').trim());
    if ('notes' in b) set('notes', (optStr(b.notes, 'Notes', 4000) ?? '').trim());
    if ('completionDate' in b) set('completion_date', optDate(b.completionDate, 'Completion date'));
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    await db.query(`UPDATE change_requests SET ${sets.join(', ')} WHERE id = $1`, vals);
    await logActivity(db, cr.projectId, req.user!.id, 'change.log_updated', { code: cr.code, fields: Object.keys(b) });
    res.json(await loadChange(db, id));
  }),
);

/** What waits for this person's decision: as head of a project's department, or as a PMO approver. */
changesRouter.get(
  '/change-requests/pending',
  route(async (req, res) => {
    const pmo = can(req, 'changes.approve');
    const { rows } = await db.query(
      `${CHANGE_SELECT.replace('FROM change_requests c', ', p.code AS project_code, p.name AS project_name FROM change_requests c JOIN projects p ON p.id = c.project_id LEFT JOIN departments d ON d.id = p.department_id')}
        WHERE c.status IN ('pending', 'on_hold') AND (c.requested_by <> $1 OR c.requested_by IS NULL) AND p.archived = 0
          AND ((c.stage = 'head' AND d.head_user_id = $1) OR (c.stage = 'pmo' AND $2 = 1))
        ORDER BY c.requested_at`,
      [req.user!.id, pmo],
    );
    res.json(rows.map((r) => ({ ...mapChange(r), projectCode: r.project_code, projectName: r.project_name })));
  }),
);
