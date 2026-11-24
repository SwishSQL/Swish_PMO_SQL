import type { Health, Stage, Task } from './types';
import { STAGES } from './types';
import { PROJECT_PHASES } from './phases';
import { expectedProgress } from './schedule';

// A project's health and stage are never typed: they are read from its plan, like its progress.
//
// Health:
//  - Done stays Done: only an approved closure finishes a project.
//  - Not started: it starts later and nothing is done yet.
//  - Delayed (red): progress more than DELAYED_GAP points behind the calendar, more than one milestone past its
//    deadline, or a milestone on the critical path past its deadline.
//  - At risk (amber): progress more than AT_RISK_GAP points behind, one milestone past its deadline (off the
//    critical path), something blocked, a milestone due within WARNING_DAYS and not started, or the closure
//    documents waiting past the plan's end.
//  - On track: otherwise.
//
// Stage moves forward on its own, never back (a project created in Execution stays there):
//  - the phase of the earliest open milestone in the plan's lifecycle phases;
//  - with no lifecycle phases in the plan (imported projects): Monitoring & Control once 70% of the milestones
//    are done, Closure once all are.

export const DELAYED_GAP = 15;
export const AT_RISK_GAP = 5;
const WARNING_DAYS = 4;

export interface StatusInput {
  tasks: Task[];
  start: string;
  end: string;
  progress: number;
  health: Health;
  stage: Stage;
  /** Blockers raised on the whole project and not cleared. */
  projectBlockers: number;
  /** Ids on the critical path: a late one there moves the finish, so it counts as Delayed. */
  critical?: Set<number>;
  today: string;
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export function deriveHealth(s: StatusInput): Health {
  if (s.health === 'done') return 'done';
  const live = s.tasks.filter((t) => t.kind !== 'summary' && !t.notRequired && t.status !== 'cancelled');
  const open = live.filter((t) => t.status !== 'done');
  if (s.start > s.today && s.progress === 0) return 'not_started';
  const milestones = open.filter((t) => t.kind === 'milestone');
  const gap = expectedProgress(s.start, s.end, s.today) - s.progress;
  // The closure documents milestone past its date says the closure is waiting, not that the work is late.
  const closing = milestones.filter((m) => m.systemKey === 'closure_docs');
  const work = milestones.filter((m) => m.systemKey !== 'closure_docs');
  const late = work.filter((m) => m.endDate < s.today);
  if (gap > DELAYED_GAP || late.length > 1 || late.some((m) => s.critical?.has(m.id))) return 'off_track';
  if (late.length === 1 || closing.some((m) => m.endDate < s.today)) return 'at_risk';
  const warn = addDays(s.today, WARNING_DAYS);
  if (
    gap > AT_RISK_GAP ||
    s.projectBlockers > 0 ||
    open.some((t) => t.status === 'blocked' || Boolean(t.blocker?.trim())) ||
    milestones.some((m) => m.endDate <= warn && (m.status === 'todo' || m.progress === 0))
  ) {
    return 'at_risk';
  }
  return 'on_track';
}

export function deriveStage(s: StatusInput): Stage {
  if (s.health === 'done') return 'closure';
  const at = (x: Stage) => STAGES.indexOf(x);
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const phaseOf = (t: Task): number => {
    let p = t.parentId ? byId.get(t.parentId) : undefined;
    while (p) {
      const i = (PROJECT_PHASES as readonly string[]).indexOf(p.name.trim());
      if (p.kind === 'summary' && i >= 0) return i;
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return -1;
  };
  const milestones = s.tasks.filter((t) => t.kind === 'milestone' && !t.notRequired && t.status !== 'cancelled');
  let found: number;
  const phased = milestones.filter((m) => phaseOf(m) >= 0);
  if (phased.length) {
    const open = phased.filter((m) => m.status !== 'done').map(phaseOf);
    found = open.length ? Math.min(...open) : at('closure');
  } else if (milestones.length) {
    const share = (milestones.filter((m) => m.status === 'done').length / milestones.length) * 100;
    found = share >= 100 ? at('closure') : share >= 70 ? at('monitoring') : -1;
  } else {
    found = -1;
  }
  return found > at(s.stage) ? STAGES[found] : s.stage;
}
