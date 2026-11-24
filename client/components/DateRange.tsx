import { useState } from 'react';
import { addDays, weekStart } from '../../shared/dates';
import { useT } from '../lib/i18n';
import { DateInput } from './DateInput';

// One date filter for every page that lists dated things: a quick range or any from/to. Empty means all dates.

export interface Range {
  from: string;
  to: string;
}
export const ALL_DATES: Range = { from: '', to: '' };

/** A date (YYYY-MM-DD) inside the range. */
export const inRange = (d: string | null | undefined, r: Range) => (!r.from && !r.to) || (!!d && (!r.from || d >= r.from) && (!r.to || d <= r.to));
/** A span (a project's start to end) that touches the range. */
export const overlaps = (start: string, end: string, r: Range) => (!r.from || end >= r.from) && (!r.to || start <= r.to);

type Preset = 'all' | 'thisWeek' | 'thisMonth' | 'thisQuarter' | 'next30' | 'last30' | 'custom';

function presetRange(p: Preset, today: string): Range {
  const month = today.slice(0, 7);
  const qStartMonth = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
  const qStart = `${today.slice(0, 4)}-${String(qStartMonth).padStart(2, '0')}-01`;
  const endOfMonth = (first: string, months: number) => {
    const d = new Date(`${first}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return addDays(d.toISOString().slice(0, 10), -1);
  };
  switch (p) {
    case 'thisWeek':
      return { from: weekStart(today), to: addDays(weekStart(today), 6) };
    case 'thisMonth':
      return { from: `${month}-01`, to: endOfMonth(`${month}-01`, 1) };
    case 'thisQuarter':
      return { from: qStart, to: endOfMonth(qStart, 3) };
    case 'next30':
      return { from: today, to: addDays(today, 30) };
    case 'last30':
      return { from: addDays(today, -30), to: today };
    default:
      return ALL_DATES;
  }
}

const PRESETS: Preset[] = ['all', 'thisWeek', 'thisMonth', 'thisQuarter', 'next30', 'last30', 'custom'];

export function DateRange({ value, onChange, today }: { value: Range; onChange: (r: Range) => void; today: string }) {
  const { t } = useT();
  // Once "Custom dates" is chosen it stays chosen, even when the dates happen to match a quick range.
  const [custom, setCustom] = useState(false);
  const current: Preset = custom
    ? 'custom'
    : (PRESETS.find((p) => p !== 'custom' && p !== 'all' && presetRange(p, today).from === value.from && presetRange(p, today).to === value.to) ??
      (!value.from && !value.to ? 'all' : 'custom'));
  return (
    <span className="date-range">
      <select
        className="select"
        style={{ width: 'auto' }}
        aria-label={t('dateFilter')}
        value={current}
        onChange={(e) => {
          const p = e.target.value as Preset;
          setCustom(p === 'custom');
          onChange(p === 'custom' ? { from: value.from || today, to: value.to || addDays(today, 30) } : presetRange(p, today));
        }}
      >
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {t(`range_${p}`)}
          </option>
        ))}
      </select>
      {current === 'custom' && (
        <>
          <DateInput className="input" aria-label={t('dateFrom')} value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          <span className="muted" aria-hidden>
            –
          </span>
          <DateInput className="input" aria-label={t('dateTo')} value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} />
        </>
      )}
    </span>
  );
}
