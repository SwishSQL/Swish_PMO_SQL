import { useMemo } from 'react';
import { makeCalendar } from '../../shared/calendar';
import type { WorkCalendar } from '../../shared/calendar';
import { weekday } from '../../shared/dates';
import { useApp } from './app';
import type { T } from './i18n';

/** The working calendar from the holidays the PMO keeps, rebuilt only when they change. */
export function useCalendar(): WorkCalendar {
  const { meta } = useApp();
  return useMemo(() => makeCalendar(meta.holidays ?? []), [meta.holidays]);
}

/** Why a day is off, for a hint under a date: the holiday's name, or the weekend day. Null on a working day. */
export function dayOffLabel(cal: WorkCalendar, iso: string, t: T, lang: 'en' | 'ar'): string | null {
  if (!iso || cal.isWorkday(iso)) return null;
  const h = cal.holiday(iso);
  if (h) return t('dayOffHoliday', { name: (lang === 'ar' && h.nameAr) || h.name });
  return t(weekday(iso) === 5 ? 'dayOffFriday' : 'dayOffSaturday');
}
