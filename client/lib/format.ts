import type { Lang } from './i18n';
import type { Department, ProjectSummary } from '../../shared/types';
import { toDay } from '../../shared/dates';

const locale = (lang: Lang) => (lang === 'ar' ? 'ar-KW-u-nu-latn' : 'en-GB');

/** '12 Oct' or '12 Oct 2026'. Dates are calendar days, formatted in UTC. */
export function fmtDate(iso: string | null | undefined, lang: Lang, withYear = false): string {
  if (!iso) return '';
  const d = new Date(toDay(iso) * 86_400_000);
  return d.toLocaleDateString(locale(lang), {
    day: 'numeric',
    month: 'short',
    year: withYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

export function fmtMonth(iso: string, lang: Lang): string {
  const d = new Date(toDay(iso) * 86_400_000);
  return d.toLocaleDateString(locale(lang), { month: 'long', timeZone: 'UTC' });
}

export function fmtDateTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(locale(lang), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kuwait',
  });
}

export function fmtNumber(n: number, lang: Lang, digits = 0): string {
  return n.toLocaleString(locale(lang), { maximumFractionDigits: digits });
}

export function projectName(p: Pick<ProjectSummary, 'name' | 'nameAr'>, lang: Lang): string {
  return lang === 'ar' && p.nameAr ? p.nameAr : p.name;
}

export function deptName(d: Department | undefined, lang: Lang): string {
  if (!d) return '';
  return lang === 'ar' && d.nameAr ? d.nameAr : d.name;
}

export function initials(name: string): string {
  const parts = name.replace(/^(Al|El)-/i, '').split(/[\s-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

export function relativeDays(iso: string, today: string, lang: Lang): string {
  const diff = toDay(iso) - toDay(today);
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar' : 'en', { numeric: 'auto' });
  if (Math.abs(diff) < 14) return rtf.format(diff, 'day');
  return rtf.format(Math.round(diff / 7), 'week');
}
