// The working calendar: Kuwait's Friday-Saturday weekend plus the official holidays the PMO keeps
// (Users & permissions -> Calendar). Used where MS Project uses its calendar: the plan's duration in
// working days, pushing successors to the next working day, and flagging a date that lands on a day off.
// The tracker's discipline flags (overdue, stale after 7 days, warning 4 days ahead) stay in calendar
// days, as the tracker counts them.

import { addDays, toDay, weekday } from './dates';

/** Friday and Saturday (0 = Sunday). */
export const WEEKEND_DAYS: readonly number[] = [5, 6];

export interface Holiday {
  date: string;
  name: string;
  nameAr: string;
}

export interface WorkCalendar {
  isWorkday(iso: string): boolean;
  /** The holiday on that day, if it is one. */
  holiday(iso: string): Holiday | undefined;
  /** The day itself when it is a working day, otherwise the next one. */
  nextWorkday(iso: string): string;
  /** n working days after iso (n >= 0); with n = 0, the day itself rolled onto a working day. */
  addWorkdays(iso: string, n: number): string;
  /** Working days from start to end, both counted. */
  workdays(start: string, end: string): number;
}

// Two years of daily checks is far below any real loop; the guard only stops a bad input from hanging.
const GUARD = 3660;

export function makeCalendar(holidays: Holiday[] = []): WorkCalendar {
  const byDate = new Map(holidays.map((h) => [h.date, h]));
  const isWorkday = (iso: string) => !WEEKEND_DAYS.includes(weekday(iso)) && !byDate.has(iso);
  const nextWorkday = (iso: string) => {
    let d = iso;
    for (let i = 0; i < GUARD && !isWorkday(d); i++) d = addDays(d, 1);
    return d;
  };
  return {
    isWorkday,
    holiday: (iso) => byDate.get(iso),
    nextWorkday,
    addWorkdays(iso, n) {
      const steps = Math.max(0, Math.floor(n));
      if (steps === 0) return nextWorkday(iso);
      // Counted from the day after, so a finish on a Friday is followed by Sunday, not Monday.
      let d = iso;
      for (let left = steps; left > 0; left--) d = nextWorkday(addDays(d, 1));
      return d;
    },
    workdays(start, end) {
      const span = toDay(end) - toDay(start);
      if (span < 0 || span > GUARD) return Math.max(0, span + 1);
      let n = 0;
      for (let i = 0, d = start; i <= span; i++, d = addDays(d, 1)) if (isWorkday(d)) n++;
      return n;
    },
  };
}

/** No holidays, weekend only: what scheduling falls back to when no calendar is passed. */
export const WEEKEND_ONLY = makeCalendar();
