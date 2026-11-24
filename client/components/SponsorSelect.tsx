import { useApp } from '../lib/app';
import { useT } from '../lib/i18n';

// The project sponsor, picked from the people with an account: executives and owners first, then department heads,
// then everyone else. A name already written that is not an account (an older project, the assistant's draft)
// stays selectable until it is replaced.

export function SponsorSelect({ value, onChange, disabled }: { value: string; onChange: (name: string) => void; disabled?: boolean }) {
  const { meta } = useApp();
  const { t } = useT();
  const active = meta.users.filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name));
  const heads = new Set(meta.departments.map((d) => d.headUserId).filter(Boolean));
  const execs = active.filter((u) => u.roleId === 'executive' || u.roleId === 'company_owner');
  const headList = active.filter((u) => heads.has(u.id) && !execs.includes(u));
  const rest = active.filter((u) => !execs.includes(u) && !headList.includes(u));
  const known = active.some((u) => u.name === value);
  return (
    <select className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={t('sponsor')}>
      <option value="">{t('pickPerson')}</option>
      {value && !known && <option value={value}>{value}</option>}
      {[
        [t('sp_execs'), execs],
        [t('sp_heads'), headList],
        [t('sp_others'), rest],
      ].map(([label, list]) =>
        (list as typeof active).length ? (
          <optgroup key={label as string} label={label as string}>
            {(list as typeof active).map((u) => (
              <option key={u.id} value={u.name}>
                {u.name}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </select>
  );
}
