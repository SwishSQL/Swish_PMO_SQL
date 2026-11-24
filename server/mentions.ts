import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { db } from './db';
import { notify } from './notify';

// @mentions: anything typed into the app (a milestone update, a blocker, an escalation note, meeting notes, a weekly
// update, a change request, a closure note) that names someone as "@Full Name" tells them, once the save went
// through. The notification links to the milestone or project it was written on.

/** The text written in a request: every string in its body (two levels deep). */
function texts(body: unknown, depth = 0): string[] {
  if (typeof body === 'string') return [body];
  if (!body || typeof body !== 'object' || depth > 2) return [];
  return Object.values(body as Record<string, unknown>).flatMap((v) => texts(v, depth + 1));
}

/** Where the request wrote: its project and, when it is about one, its milestone or task. */
async function placeOf(path: string): Promise<{ projectId: number | null; taskId: number | null }> {
  const n = (re: RegExp) => Number(path.match(re)?.[1] ?? 0) || null;
  const task = n(/^\/tasks\/(\d+)/);
  if (task) {
    const { rows } = await db.query('SELECT project_id FROM tasks WHERE id = $1', [task]);
    return { projectId: rows[0]?.project_id ?? null, taskId: task };
  }
  const project = n(/^\/projects\/(\d+)/);
  if (project) return { projectId: project, taskId: null };
  const lookups: [RegExp, string][] = [
    [/^\/updates\/(\d+)/, 'SELECT project_id, NULL AS task_id FROM status_updates WHERE id = $1'],
    [/^\/changes\/(\d+)/, 'SELECT project_id, NULL AS task_id FROM change_requests WHERE id = $1'],
    [/^\/closure-requests\/(\d+)/, 'SELECT project_id, NULL AS task_id FROM closure_requests WHERE id = $1'],
    [/^\/risks\/(\d+)/, 'SELECT project_id, NULL AS task_id FROM risks WHERE id = $1'],
    [/^\/deadline-changes\/(\d+)/, 'SELECT t.project_id, t.id AS task_id FROM deadline_changes c JOIN tasks t ON t.id = c.task_id WHERE c.id = $1'],
    [/^\/escalations\/(\d+)/, 'SELECT t.project_id, t.id AS task_id FROM escalations e JOIN tasks t ON t.id = e.task_id WHERE e.id = $1'],
  ];
  for (const [re, sql] of lookups) {
    const id = n(re);
    if (!id) continue;
    const { rows } = await db.query(sql, [id]);
    return { projectId: rows[0]?.project_id ?? null, taskId: rows[0]?.task_id ?? null };
  }
  return { projectId: null, taskId: null };
}

/** The accounts named in the text as "@Full Name" (the longest names first, so a short one inside a long one does not count twice). */
export async function mentioned(all: string): Promise<{ id: number; name: string; at: number }[]> {
  if (!all.includes('@')) return [];
  const { rows } = await db.query('SELECT id, name FROM users WHERE active = 1 ORDER BY LEN(name) DESC');
  const lower = all.toLowerCase();
  const taken: [number, number][] = [];
  const out: { id: number; name: string; at: number }[] = [];
  for (const u of rows) {
    const key = `@${String(u.name).toLowerCase()}`;
    let at = lower.indexOf(key);
    while (at >= 0) {
      const end = at + key.length;
      if (!taken.some(([a, b]) => at < b && end > a)) {
        taken.push([at, end]);
        if (!out.some((x) => x.id === u.id)) out.push({ id: u.id, name: u.name, at });
      }
      at = lower.indexOf(key, end);
    }
  }
  return out;
}

export function mentionWatcher(req: Request, res: Response, next: NextFunction): void {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !req.user || req.realUser) return next();
  const all = texts(req.body).join('\n');
  if (!all.includes('@')) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    void (async () => {
      try {
        const people = (await mentioned(all)).filter((p) => p.id !== req.user!.id);
        if (!people.length) return;
        const place = await placeOf(req.path);
        const { rows: pr } = place.projectId ? await db.query('SELECT code, name FROM projects WHERE id = $1', [place.projectId]) : { rows: [] as any[] };
        const { rows: tr } = place.taskId ? await db.query('SELECT name FROM tasks WHERE id = $1', [place.taskId]) : { rows: [] as any[] };
        for (const p of people) {
          // The sentence around the mention, as the notification shows it.
          const start = Math.max(0, all.lastIndexOf('\n', p.at) + 1, p.at - 80);
          const excerpt = all.slice(start, Math.min(all.length, p.at + p.name.length + 120)).trim();
          const hash = createHash('sha1').update(`${p.id}|${all}`).digest('hex').slice(0, 16);
          await notify(
            db,
            [p.id],
            {
              kind: 'mention',
              projectId: place.projectId,
              taskId: place.taskId,
              data: { by: req.user!.name, excerpt, project: pr[0] ? `${pr[0].code} ${pr[0].name}` : '', name: tr[0]?.name ?? '' },
              dedupe: `mention:${hash}`,
            },
            req.user!.id,
          );
        }
      } catch (e) {
        console.error('[mentions]', (e as Error).message);
      }
    })();
  });
  next();
}
