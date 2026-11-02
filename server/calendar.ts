import type { Queryable } from './db';
import { mapHoliday } from './mappers';
import { makeCalendar } from '../shared/calendar';
import type { Holiday, WorkCalendar } from '../shared/calendar';

export async function loadHolidays(q: Queryable): Promise<Holiday[]> {
  const { rows } = await q.query('SELECT * FROM holidays ORDER BY [day]');
  return rows.map(mapHoliday);
}

/** The working calendar as the PMO keeps it now: the weekend plus the holidays on record. */
export async function loadCalendar(q: Queryable): Promise<WorkCalendar> {
  return makeCalendar(await loadHolidays(q));
}
