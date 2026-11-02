// The tracker names people as text ("Ravi", "Ahmed Hafez"); the app knows
// people as users. This links the two once an account exists: a task's owner
// and a project's owner become the user when exactly one user matches.

import type { Queryable } from './db';
import { db } from './db';

/** Lower-case, no punctuation, single spaces: "Mo. Alsayed" and "mo alsayed" match. */
export function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Known typos in the tracker, folded into the spelling used most. Reported by the import. */
export const NAME_ALIASES: Record<string, string> = {
  rajab: 'Ragab',
  mossallam: 'Mosallam',
  musallam: 'Mosallam',
  huwailah: 'Huwaila',
};

export function cleanName(raw: unknown): string | null {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return NAME_ALIASES[norm(s)] ?? s;
}

/**
 * A user matches a tracker name when the full names are equal, or when the
 * tracker holds only a first name and exactly one user has that first name.
 */
export function buildMatcher(users: { id: number; name: string }[]): (name: string | null) => number | null {
  const byFull = new Map<string, number[]>();
  const byFirst = new Map<string, number[]>();
  for (const u of users) {
    const full = norm(u.name);
    const first = full.split(' ')[0];
    byFull.set(full, [...(byFull.get(full) ?? []), u.id]);
    byFirst.set(first, [...(byFirst.get(first) ?? []), u.id]);
  }
  return (name) => {
    const n = norm(name);
    if (!n) return null;
    const full = byFull.get(n);
    if (full?.length === 1) return full[0];
    if (!n.includes(' ')) {
      const first = byFirst.get(n);
      if (first?.length === 1) return first[0];
    }
    return null;
  };
}

export async function linkPeople(q: Queryable = db): Promise<{ tasks: number; projects: number }> {
  const { rows: users } = await q.query('SELECT id, name FROM users WHERE active = 1');
  const match = buildMatcher(users);

  let tasks = 0;
  let projects = 0;
  const { rows: ts } = await q.query(
    `SELECT DISTINCT owner_name FROM tasks WHERE assignee_id IS NULL AND owner_name IS NOT NULL`,
  );
  for (const t of ts) {
    const id = match(t.owner_name);
    if (!id) continue;
    const r = await q.query('UPDATE tasks SET assignee_id = $1 WHERE assignee_id IS NULL AND owner_name = $2', [id, t.owner_name]);
    tasks += (r as any).rowCount ?? (r as any).affectedRows ?? 0;
  }
  const { rows: ps } = await q.query(`SELECT DISTINCT owner_name FROM projects WHERE manager_id IS NULL AND owner_name IS NOT NULL`);
  for (const p of ps) {
    const id = match(p.owner_name);
    if (!id) continue;
    const r = await q.query('UPDATE projects SET manager_id = $1 WHERE manager_id IS NULL AND owner_name = $2', [id, p.owner_name]);
    projects += (r as any).rowCount ?? (r as any).affectedRows ?? 0;
    await q.query(
      `INSERT INTO project_members (project_id, user_id, role)
       SELECT p.id, $1, 'Project manager' FROM projects p WHERE p.manager_id = $1
          AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $1)`,
      [id],
    );
  }
  // Co-owners: each name on a task's co-owners list that matches an account.
  const { rows: cs } = await q.query('SELECT DISTINCT co_owners FROM tasks WHERE co_owners IS NOT NULL');
  for (const c of cs) {
    for (const n of splitList(c.co_owners)) {
      const uid = match(n);
      if (!uid) continue;
      await q.query(
        `INSERT INTO task_coowners (task_id, user_id) SELECT t.id, $1 FROM tasks t WHERE t.co_owners = $2
            AND NOT EXISTS (SELECT 1 FROM task_coowners c WHERE c.task_id = t.id AND c.user_id = $1)`,
        [uid, c.co_owners],
      );
    }
  }
  // Whoever owns or co-owns a task is on that project's team, so they can update it.
  await q.query(
    `INSERT INTO project_members (project_id, user_id, role)
     SELECT DISTINCT t.project_id, c.user_id, 'Member' FROM task_coowners c JOIN tasks t ON t.id = c.task_id
      WHERE NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = t.project_id AND m.user_id = c.user_id)`,
  );
  await q.query(
    `INSERT INTO project_members (project_id, user_id, role)
     SELECT DISTINCT t.project_id, t.assignee_id, 'Member' FROM tasks t WHERE t.assignee_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = t.project_id AND m.user_id = t.assignee_id)`,
  );
  return { tasks, projects };
}

// ---- Directory ----------------------------------------------------------------
// Everyone the tracker names, worked out from the plans themselves so it can
// never drift from them: a person, a team or role, or an outside party.

export type NameKind = 'person' | 'team' | 'external';

const EXTERNAL = /(^mr\.?\s.+,)|\b(kpmg|kmpg|etc|egc|beon|menaitech|vendor|consultant|third party)\b/i;
const TEAM =
  /[+&/]|\b(team|teams|heads?|managers?|department|departments|it|hr|ops|operations|transformation|administrator|developer|accountants|commerce|brand|warehouse|cpu|marketing|finance)\b/i;

export function classify(name: string): NameKind {
  if (EXTERNAL.test(name)) return 'external';
  if (TEAM.test(name)) return 'team';
  return 'person';
}

export interface DirectoryEntry {
  name: string;
  kind: NameKind;
  projects: number;
  sponsored: number;
  milestones: number;
  openMilestones: number;
  overdue: number;
  coOwned: number;
  escalations: number;
  userId: number | null;
}

export function splitList(s: string | null | undefined): string[] {
  return String(s ?? '')
    .split(/\s*,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function directory(today: string, q: Queryable = db): Promise<DirectoryEntry[]> {
  const [{ rows: tasks }, { rows: projects }, { rows: users }] = await Promise.all([
    q.query(
      `SELECT t.owner_name, t.co_owners, t.escalate_to, t.status, t.end_date
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.kind = 'milestone' AND p.archived = 0`,
    ),
    q.query('SELECT owner_name, sponsor FROM projects WHERE archived = 0'),
    q.query('SELECT id, name FROM users WHERE active = 1'),
  ]);
  const match = buildMatcher(users);
  const map = new Map<string, DirectoryEntry>();
  const entry = (name: string): DirectoryEntry => {
    let e = map.get(name);
    if (!e) {
      e = { name, kind: classify(name), projects: 0, sponsored: 0, milestones: 0, openMilestones: 0, overdue: 0, coOwned: 0, escalations: 0, userId: match(name) };
      map.set(name, e);
    }
    return e;
  };
  for (const t of tasks) {
    const open = t.status !== 'done' && t.status !== 'cancelled';
    if (t.owner_name) {
      const e = entry(t.owner_name);
      e.milestones++;
      if (open) e.openMilestones++;
      if (open && t.end_date < today) e.overdue++;
    }
    for (const c of splitList(t.co_owners)) entry(c).coOwned++;
    if (t.escalate_to) entry(t.escalate_to).escalations++;
  }
  for (const p of projects) {
    if (p.owner_name) entry(p.owner_name).projects++;
    if (p.sponsor) entry(p.sponsor).sponsored++;
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Folds one spelling into another everywhere a name is written: milestone
 * owners, co-owner lists, escalations, project owners and sponsors.
 */
export async function mergeName(q: Queryable, from: string, to: string): Promise<number> {
  let changed = 0;
  const count = (r: any) => r.rowCount ?? r.affectedRows ?? 0;
  changed += count(await q.query('UPDATE tasks SET owner_name = $2 WHERE owner_name = $1', [from, to]));
  changed += count(await q.query('UPDATE tasks SET escalate_to = $2 WHERE escalate_to = $1', [from, to]));
  changed += count(await q.query('UPDATE projects SET owner_name = $2 WHERE owner_name = $1', [from, to]));
  changed += count(await q.query('UPDATE projects SET sponsor = $2 WHERE sponsor = $1', [from, to]));
  const { rows } = await q.query('SELECT id, co_owners FROM tasks WHERE co_owners IS NOT NULL');
  for (const r of rows) {
    const list = splitList(r.co_owners);
    if (!list.includes(from)) continue;
    const next = [...new Set(list.map((x) => (x === from ? to : x)))].join(', ');
    await q.query('UPDATE tasks SET co_owners = $2 WHERE id = $1', [r.id, next]);
    changed++;
  }
  return changed;
}
