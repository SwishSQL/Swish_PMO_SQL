import { Router } from 'express';
import type { Response } from 'express';
import type ExcelJS from 'exceljs';
import { db } from '../db';
import { HttpError, canViewProject, route, seesAllProjects } from '../auth';
import { projectVisibleSql, taskVisibleSql } from '../visibility';
import { idParam } from '../validate';
import { listProjects } from '../service';
import { milestonesWorkbook, portfolioWorkbook, projectWorkbook, toBuffer } from '../export';
import { todayIso } from '../../shared/dates';

// Excel downloads. Each one shows exactly what the person may see on screen:
// the same visibility rule as the portfolio and the Milestones page.
export const exportRouter = Router();

async function send(res: Response, wb: ExcelJS.Workbook, name: string): Promise<void> {
  const buf = await toBuffer(wb);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9._-]+/g, '-')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

/** ?quarter=<id> for the projects in that quarter (as the portfolio shows them), ?quarter=all for every project. */
exportRouter.get(
  '/export/portfolio.xlsx',
  route(async (req, res) => {
    const raw = String(req.query.quarter ?? 'all');
    const quarterId = raw === 'all' ? null : idParam(raw);
    const projects = await listProjects(quarterId, seesAllProjects(req) ? null : req.user!.id);
    let label = 'all';
    if (quarterId) {
      const { rows } = await db.query('SELECT code FROM quarters WHERE id = $1', [quarterId]);
      if (!rows[0]) throw new HttpError(404, 'Quarter not found.');
      label = rows[0].code;
    }
    await send(res, await portfolioWorkbook(projects.map((p) => p.id)), `swish-pmo-portfolio-${label}-${todayIso()}.xlsx`);
  }),
);

/** The milestones the person picked on the Milestones page (by id), filtered again by visibility. */
exportRouter.post(
  '/export/milestones.xlsx',
  route(async (req, res) => {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 10_000 || !ids.every((x) => Number.isInteger(x) && x > 0)) {
      throw new HttpError(400, 'Send the milestone ids to export.');
    }
    const visibleTo = seesAllProjects(req) ? null : req.user!.id;
    const { rows } = await db.query(
      `SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.id IN (SELECT value FROM OPENJSON($1)) AND t.kind = 'milestone' AND p.archived = 0
          AND ${projectVisibleSql('p', '$2')} AND ${taskVisibleSql('t', 'p', '$2')}`,
      [ids, visibleTo],
    );
    await send(res, await milestonesWorkbook(rows.map((r) => r.id)), `swish-pmo-milestones-${todayIso()}.xlsx`);
  }),
);

exportRouter.get(
  '/projects/:id/export.xlsx',
  route(async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await canViewProject(req, id))) throw new HttpError(404, 'Project not found.');
    const { wb, code } = await projectWorkbook(id);
    await send(res, wb, `swish-pmo-${code}-${todayIso()}.xlsx`);
  }),
);
