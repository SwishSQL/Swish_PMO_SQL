import { PROJECT_PHASES } from '../../shared/phases';
import { useT } from '../lib/i18n';

/**
 * The fixed phases of a project. Tick the ones this project needs; the others still appear in the plan, marked
 * "Not required", so every project reads the same way.
 */
export function PhasePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useT();
  const toggle = (p: string) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  return (
    <div className="field span-2">
      <span>{t('phases')}</span>
      <div className="phase-picker" role="group" aria-label={t('phases')}>
        {PROJECT_PHASES.map((p, i) => (
          <button key={p} type="button" className={`chip phase-chip ${value.includes(p) ? 'on' : ''}`} aria-pressed={value.includes(p)} onClick={() => toggle(p)}>
            <span className="num phase-n">{i + 1}</span>
            {p}
          </button>
        ))}
      </div>
      <span className="hint">{t('phasesHint')}</span>
    </div>
  );
}
