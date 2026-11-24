import { useApp } from '../lib/app';
import { useT } from '../lib/i18n';

// Several people picked from the accounts (key stakeholders, say), kept as a comma-separated list of names so older
// free-text entries still show; each one can be removed.

export function PeoplePicker({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label: string }) {
  const { meta } = useApp();
  const { t } = useT();
  const list = value
    .split(/\s*[,،\n]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  const set = (next: string[]) => onChange([...new Set(next)].join(', '));
  const free = meta.users.filter((u) => u.active && !list.includes(u.name)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="chips-pick">
      {list.map((n) => (
        <span key={n} className="flag-chip">
          {n}
          {!disabled && (
            <button type="button" className="chip-x" aria-label={`${t('remove')} ${n}`} onClick={() => set(list.filter((x) => x !== n))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <select className="select" style={{ width: 'auto', minWidth: 200 }} aria-label={label} value="" onChange={(e) => e.target.value && set([...list, e.target.value])}>
          <option value="">{t('pp_add')}</option>
          {free.map((u) => (
            <option key={u.id} value={u.name}>
              {u.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
