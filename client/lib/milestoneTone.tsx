import { milestoneFlags } from '../../shared/health';
import { useT } from './i18n';

// One colour per milestone, the same everywhere (My work, Milestones, the plan). When several apply, the most
// urgent wins: overdue, then blocked, then at risk. The rules are the tracker's flags (shared/health), so the
// colours agree with the follow-ups and the counters. A label always goes with the colour.

export type MsTone = 'overdue' | 'blocked' | 'atRisk' | 'inProgress' | 'notStarted' | 'done' | 'cancelled';
export const MS_TONES: MsTone[] = ['overdue', 'blocked', 'atRisk', 'inProgress', 'notStarted', 'done', 'cancelled'];

export function milestoneTone(
  m: { status: string; date: string; progress: number; blocker: string | null; lastUpdateOn: string | null; notRequired?: boolean },
  today: string,
): MsTone {
  if (m.status === 'cancelled' || m.notRequired) return 'cancelled';
  if (m.status === 'done') return 'done';
  const f = milestoneFlags(m, today);
  if (f.overdue) return 'overdue';
  if (f.earlyWarning) return 'blocked';
  if (f.autoAtRisk) return 'atRisk';
  if (m.status === 'in_progress' || m.progress > 0) return 'inProgress';
  return 'notStarted';
}

/** The status pill in the milestone's colour. */
export function MsPill({ tone, progress }: { tone: MsTone; progress?: number }) {
  const { t } = useT();
  return (
    <span className={`pill ms-tone-${tone}`}>
      {t(`ms_${tone}`)}
      {progress !== undefined && progress > 0 && tone !== 'done' && tone !== 'cancelled' && <span className="num">{progress}%</span>}
    </span>
  );
}

/** What the colours mean, above a list. */
export function MsLegend() {
  const { t } = useT();
  return (
    <div className="ms-legend" aria-label={t('msLegend')}>
      {MS_TONES.map((tone) => (
        <span key={tone} className={`ms-tone-${tone}`}>
          <i aria-hidden />
          {t(`ms_${tone}`)}
        </span>
      ))}
    </div>
  );
}
