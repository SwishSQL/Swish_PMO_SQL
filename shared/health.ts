import { addDays } from './dates';

// The tracker's weekly-discipline flags, worked out from the milestone itself.
// The thresholds are the tracker's own defaults (a milestone with no report for
// over a week is stale, a warning fires four days before the deadline) and are
// the PMO's to confirm: change them here, one place for the whole system.

/** Open milestones with no report for more than this many days "need an update". */
export const STALE_DAYS = 7;
/** The warning trigger: this many days before the deadline. */
export const WARNING_DAYS = 4;

export interface FlagInput {
  status: string;
  /** The deadline (effective). */
  date: string;
  progress: number;
  blocker: string | null;
  lastUpdateOn: string | null;
  /** The day the first escalation was raised on it, if any. */
  escalatedOn?: string | null;
}

export interface Flags {
  open: boolean;
  /** Past its deadline and still open. */
  overdue: boolean;
  /** No report for more than STALE_DAYS (never reported counts). */
  needsUpdate: boolean;
  /** Not late yet, but a blocker is logged or the item is blocked. */
  earlyWarning: boolean;
  /** Not late yet, inside the warning window and not started: heading for a miss. */
  autoAtRisk: boolean;
  /** Past its deadline and still open, and nobody has escalated it. */
  escalationMissing: boolean;
  /** First escalated after the deadline had passed: the tracker's "late is unacceptable". */
  escalationLate: boolean;
}

// The two cut-off dates depend only on today, and a list of 700+ milestones asks for them thousands of
// times (every filter, every count): work them out once per day.
let cutFor = '';
let staleCut = '';
let warnCut = '';
function cuts(today: string): void {
  if (cutFor === today) return;
  cutFor = today;
  staleCut = addDays(today, -STALE_DAYS);
  warnCut = addDays(today, WARNING_DAYS);
}

export function milestoneFlags(m: FlagInput, today: string): Flags {
  cuts(today);
  const open = m.status !== 'done' && m.status !== 'cancelled';
  const overdue = open && m.date < today;
  const needsUpdate = open && (!m.lastUpdateOn || m.lastUpdateOn < staleCut);
  const live = open && !overdue;
  const earlyWarning = live && (m.status === 'blocked' || Boolean(m.blocker?.trim()));
  const autoAtRisk = live && m.date <= warnCut && (m.status === 'todo' || m.progress === 0);
  const escalationMissing = overdue && !m.escalatedOn;
  const escalationLate = open && Boolean(m.escalatedOn) && (m.escalatedOn as string) > m.date;
  return { open, overdue, needsUpdate, earlyWarning, autoAtRisk, escalationMissing, escalationLate };
}
