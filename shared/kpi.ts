import { expectedProgress } from './schedule';

// One definition per portfolio figure, used by the Portfolio, the Dashboard and the Executive report alike, so the
// same measure shows the same number everywhere (given the same projects and period).
//
//  - Active projects: not closed.
//  - Progress: the simple average of the active projects' progress. Expected: the share of each of those
//    projects' dates already passed by today, averaged over the same projects (one not started yet counts 0).
//  - Overdue milestones: required milestones (not "Not required", not cancelled) of active projects, past their
//    date and not done.

interface ProjectLike {
  health: string;
  progress: number;
  startDate: string;
  endDate: string;
}

export const isActive = (p: { health: string }) => p.health !== 'done';

export function progressKpi(projects: ProjectLike[], today: string): { actual: number; expected: number; n: number } {
  const active = projects.filter(isActive);
  if (!active.length) return { actual: 0, expected: 0, n: 0 };
  const actual = Math.round(active.reduce((s, p) => s + p.progress, 0) / active.length);
  const expected = Math.round(active.reduce((s, p) => s + expectedProgress(p.startDate, p.endDate, today), 0) / active.length);
  return { actual, expected, n: active.length };
}

/** A milestone that counts in the portfolio figures. */
export const countsAsMilestone = (m: { status?: string; notRequired?: boolean; projectHealth?: string }) =>
  m.status !== 'cancelled' && !m.notRequired && (m.projectHealth === undefined || m.projectHealth !== 'done');

export const isOverdue = (m: { status?: string; date: string; done?: boolean }, today: string) =>
  !(m.done ?? m.status === 'done') && m.status !== 'cancelled' && m.date < today;
