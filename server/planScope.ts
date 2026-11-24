import type { Request } from 'express';
import type { Queryable } from './db';
import { db } from './db';
import { can, canManageAccounts } from './auth';

// Which plan projects (initiatives) a person sees in the Transformation plan, and may start a project from.
// The PMO and the system admins: all of them (null). Anyone else: those under the portfolios and programs they
// manage, and those already delivered by a project of a department they head or a project they run.

export async function planScope(req: Request, q: Queryable = db): Promise<Set<number> | null> {
  if (canManageAccounts(req) || can(req, 'projects.edit_all')) return null;
  const me = req.user!.id;
  const { rows } = await q.query(
    `SELECT i.id FROM initiatives i JOIN dimensions d ON d.id = i.dimension_id JOIN capabilities c ON c.id = d.capability_id
      WHERE d.manager_user_id = $1 OR c.manager_user_id = $1
     UNION
     SELECT p.initiative_id FROM projects p LEFT JOIN departments dp ON dp.id = p.department_id
      WHERE p.initiative_id IS NOT NULL AND p.archived = 0 AND (dp.head_user_id = $1 OR p.manager_id = $1)`,
    [me],
  );
  return new Set(rows.map((r) => r.id ?? r.initiative_id));
}
