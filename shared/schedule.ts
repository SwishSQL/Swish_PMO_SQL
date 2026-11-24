// Scheduling engine: summary roll-ups, weighted progress, critical path and
// forward propagation along finish-to-start links. Runs identically on the
// server (to persist) and in the browser (to preview a drag before it lands).

import type { Dependency, Task } from './types';
import { addDays, diffDays, fromDay, spanDays, toDay } from './dates';
import { WEEKEND_ONLY } from './calendar';
import type { WorkCalendar } from './calendar';

type TaskLike = Pick<Task, 'id' | 'parentId' | 'kind' | 'startDate' | 'endDate' | 'progress'> & { status?: Task['status'] };

export function childrenMap<T extends TaskLike>(tasks: T[]): Map<number | null, T[]> {
  const map = new Map<number | null, T[]>();
  for (const t of tasks) {
    const key = t.parentId ?? null;
    const list = map.get(key);
    if (list) list.push(t);
    else map.set(key, [t]);
  }
  return map;
}

/**
 * Weight of a leaf in progress maths: its length in days, a milestone counts as
 * one, a cancelled item counts for nothing.
 */
function weight(t: TaskLike): number {
  if (t.status === 'cancelled') return 0;
  return t.kind === 'milestone' ? 1 : Math.max(1, spanDays(t.startDate, t.endDate));
}

/**
 * Share of a leaf that is done. A milestone is reached or it is not: 40% of a
 * milestone is not a milestone. Its status is the judge when it has one, as in
 * the tracker, where a milestone at 100% but still "On Track" is not complete.
 */
function doneShare(t: TaskLike): number {
  if (t.kind === 'milestone') return (t.status ? t.status === 'done' : t.progress >= 100) ? 1 : 0;
  return t.progress / 100;
}

/**
 * Summary rows take their dates and progress from their children, as in
 * MS Project. Returns new objects only for summaries whose values changed.
 */
export function rollUp<T extends TaskLike>(tasks: T[]): T[] {
  const byParent = childrenMap(tasks);
  const out = new Map<number, T>(tasks.map((t) => [t.id, { ...t }]));

  const visit = (t: T): { start: string; end: string; w: number; done: number } | null => {
    const node = out.get(t.id)!;
    const kids = byParent.get(t.id) ?? [];
    if (node.kind === 'summary' && kids.length === 0) return { start: node.startDate, end: node.endDate, w: 0, done: 0 };
    if (node.kind !== 'summary') {
      // A milestone keeps its own date and status; the tasks that lead to it widen what its phase spans and
      // count as work of their own. Its % is theirs (weighted by length): nobody types it by hand.
      const own = weight(node);
      let start = node.startDate;
      let end = node.endDate;
      let w = own;
      let done = own * doneShare(node);
      let kidsW = 0;
      let kidsDone = 0;
      for (const k of kids) {
        const r = visit(k);
        if (!r) continue;
        if (r.start < start) start = r.start;
        if (r.end > end) end = r.end;
        w += r.w;
        done += r.done;
        kidsW += r.w;
        kidsDone += r.done;
      }
      if (node.kind === 'milestone' && kidsW > 0) node.progress = node.status === 'done' ? 100 : Math.round((kidsDone / kidsW) * 100);
      return { start, end, w, done };
    }
    let start = '';
    let end = '';
    let w = 0;
    let done = 0;
    for (const k of kids) {
      const r = visit(k);
      if (!r) continue;
      if (!start || r.start < start) start = r.start;
      if (!end || r.end > end) end = r.end;
      w += r.w;
      done += r.done;
    }
    if (start && end) {
      node.startDate = start;
      node.endDate = end;
      node.progress = w ? Math.round((done / w) * 100) : 0;
    }
    return { start: node.startDate, end: node.endDate, w, done };
  };

  for (const root of byParent.get(null) ?? []) visit(root);
  // Orphans whose parent was deleted still need a visit.
  for (const t of tasks) if (t.parentId && !out.has(t.parentId)) visit(t);
  return tasks.map((t) => out.get(t.id)!);
}

/** Duration-weighted progress over leaf rows, 0-100. */
export function projectProgress(tasks: TaskLike[]): number {
  let w = 0;
  let done = 0;
  for (const t of tasks) {
    if (t.kind === 'summary') continue;
    const tw = weight(t);
    w += tw;
    done += tw * doneShare(t);
  }
  return w ? Math.round((done / w) * 100) : 0;
}

/** Share of the planned window already elapsed: what progress "should" be today. */
export function expectedProgress(start: string, end: string, today: string): number {
  const total = spanDays(start, end);
  if (total <= 0) return 0;
  const gone = diffDays(start, today) + 1;
  return Math.max(0, Math.min(100, Math.round((gone / total) * 100)));
}

export interface CriticalInfo {
  /** Days a task can slip without moving the project finish. */
  floatDays: Map<number, number>;
  critical: Set<number>;
  finish: string | null;
}

/**
 * Critical path over leaf tasks with finish-to-start links. Planned starts are
 * treated as "start no earlier than", so the forward pass is the plan itself;
 * the backward pass from the latest finish yields total float.
 */
export function criticalPath(tasks: TaskLike[], deps: Dependency[]): CriticalInfo {
  const parents = new Set(tasks.map((t) => t.parentId).filter((v): v is number => v !== null));
  const leaves = tasks.filter((t) => t.kind !== 'summary');
  const ids = new Set(leaves.map((t) => t.id));
  const links = deps.filter((d) => ids.has(d.predecessorId) && ids.has(d.successorId));
  const floatDays = new Map<number, number>();
  const critical = new Set<number>();
  if (leaves.length === 0) return { floatDays, critical, finish: null };

  // With no links there is no chain of work to be critical: every task would
  // look critical just for ending last. Say nothing instead.
  if (links.length === 0) {
    for (const t of leaves) floatDays.set(t.id, Math.max(0, Math.max(...leaves.map((x) => toDay(x.endDate))) - toDay(t.endDate)));
    return { floatDays, critical, finish: fromDay(Math.max(...leaves.map((t) => toDay(t.endDate)))) };
  }

  const succ = new Map<number, Dependency[]>();
  for (const d of links) {
    if (d.successorId === d.predecessorId) continue;
    const l = succ.get(d.predecessorId);
    if (l) l.push(d);
    else succ.set(d.predecessorId, [d]);
  }
  const byId = new Map(leaves.map((t) => [t.id, t]));
  const finish = Math.max(...leaves.map((t) => toDay(t.endDate)));

  // Late finish, memoised depth-first. Cycles are rejected on write, but a
  // guard keeps a bad row from hanging the page.
  const lateFinish = new Map<number, number>();
  const onStack = new Set<number>();
  const lf = (id: number): number => {
    const cached = lateFinish.get(id);
    if (cached !== undefined) return cached;
    if (onStack.has(id)) return finish;
    onStack.add(id);
    let value = finish;
    for (const d of succ.get(id) ?? []) {
      const s = byId.get(d.successorId)!;
      const ls = lf(s.id) - (toDay(s.endDate) - toDay(s.startDate));
      value = Math.min(value, ls - 1 - d.lagDays);
    }
    onStack.delete(id);
    lateFinish.set(id, value);
    return value;
  };

  for (const t of leaves) {
    const fl = lf(t.id) - toDay(t.endDate);
    floatDays.set(t.id, fl);
    if (fl <= 0 && t.progress < 100) critical.add(t.id);
  }
  return { floatDays, critical, finish: fromDay(finish) };
}

/**
 * After a task moves, push every successor that now starts too early forward,
 * keeping its duration. Never pulls work earlier - the planner decides that.
 * On the working calendar, as MS Project: a successor starts on the first working day after its
 * predecessor (plus the lag, in working days) and keeps its length in working days.
 */
export function propagate<T extends TaskLike>(
  tasks: T[],
  deps: Dependency[],
  movedId: number,
  cal: WorkCalendar = WEEKEND_ONLY,
): Map<number, { startDate: string; endDate: string }> {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  const succ = new Map<number, Dependency[]>();
  for (const d of deps) {
    const l = succ.get(d.predecessorId);
    if (l) l.push(d);
    else succ.set(d.predecessorId, [d]);
  }
  const changed = new Map<number, { startDate: string; endDate: string }>();
  const queue = [movedId];
  let guard = 0;
  while (queue.length && guard++ < 10_000) {
    const id = queue.shift()!;
    const pred = byId.get(id);
    if (!pred) continue;
    for (const d of succ.get(id) ?? []) {
      const s = byId.get(d.successorId);
      if (!s || s.kind === 'summary') continue;
      // A lead (negative lag) overlaps in calendar days, then lands on a working day.
      const earliest = 1 + d.lagDays >= 1 ? cal.addWorkdays(pred.endDate, 1 + d.lagDays) : cal.nextWorkday(addDays(pred.endDate, 1 + d.lagDays));
      if (s.startDate < earliest) {
        const len = Math.max(1, cal.workdays(s.startDate, s.endDate));
        s.startDate = earliest;
        s.endDate = s.kind === 'milestone' ? earliest : cal.addWorkdays(earliest, len - 1);
        changed.set(s.id, { startDate: s.startDate, endDate: s.endDate });
        queue.push(s.id);
      }
    }
  }
  return changed;
}

/** True when linking pred -> succ would close a loop. */
export function createsCycle(deps: Pick<Dependency, 'predecessorId' | 'successorId'>[], pred: number, succ: number): boolean {
  if (pred === succ) return true;
  const next = new Map<number, number[]>();
  for (const d of deps) {
    const l = next.get(d.predecessorId);
    if (l) l.push(d.successorId);
    else next.set(d.predecessorId, [d.successorId]);
  }
  const seen = new Set<number>();
  const stack = [succ];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === pred) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of next.get(id) ?? []) stack.push(n);
  }
  return false;
}
