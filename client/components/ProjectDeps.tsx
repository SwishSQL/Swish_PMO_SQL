import { useState } from 'react';
import { LockSimple } from '@phosphor-icons/react';
import type { ProjectDetail, ProjectSummary } from '../../shared/types';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate } from '../lib/format';

// Projects that wait for others: the banner on the waiting project, and the PMO's picker in its Details.

export function DependsBar({ detail }: { detail: ProjectDetail }) {
  const { t, lang } = useT();
  const links = detail.dependsOn ?? [];
  const waiting = links.filter((l) => l.open && !l.startedBefore);
  const shown = links.filter((l) => l.open && l.startedBefore);
  if (!waiting.length && !shown.length) return null;
  const start = detail.project.startDate;
  const early = [...waiting, ...shown].filter((l) => start < l.endDate);
  const list = (ls: typeof links) =>
    ls.map((l, i) => (
      <span key={l.id}>
        {i > 0 && ', '}
        <a href={`#/projects/${l.id}/plan`}>
          {l.code} {l.name}
        </a>
      </span>
    ));
  return (
    <div className={`closure-bar deps-bar ${waiting.length ? 'pending' : ''}`} role="status">
      <LockSimple size={16} weight="bold" aria-hidden />
      <span className="closure-text">
        {waiting.length > 0 && (
          <>
            {t('dep_waiting')} {list(waiting)} {t('dep_waitingWhat')}
          </>
        )}
        {shown.length > 0 && (
          <>
            {' '}
            {t('dep_startedBefore')} {list(shown)}.
          </>
        )}
        {early.map((l) => (
          <span key={l.id} className="dep-early">
            {' '}
            {t('dep_early', { start: fmtDate(start, lang, true), code: l.code, end: fmtDate(l.endDate, lang, true) })}
          </span>
        ))}
      </span>
    </div>
  );
}

/** The PMO picks the projects this one waits for. */
export function DependsOnEditor({ detail, onSaved }: { detail: ProjectDetail; onSaved: () => void }) {
  const { t } = useT();
  const { can } = useApp();
  const toast = useToast();
  const { data: all } = useLoad(() => api.get<ProjectSummary[]>('/api/projects'), [], 'projects-all');
  const [busy, setBusy] = useState(false);
  if (!can('projects.edit_all')) return null;
  const ids = (detail.dependsOn ?? []).map((l) => l.id);
  const save = async (next: number[]) => {
    setBusy(true);
    try {
      await api.put(`/api/projects/${detail.project.id}/depends-on`, { ids: next });
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const options = (all ?? []).filter((p) => p.id !== detail.project.id && !ids.includes(p.id)).sort((a, b) => a.code.localeCompare(b.code));
  return (
    <div className="field span-2">
      <span>{t('dep_label')}</span>
      <div className="chips-pick">
        {(detail.dependsOn ?? []).map((l) => (
          <span key={l.id} className={`flag-chip ${l.open ? 'warn' : ''}`}>
            {l.code} {l.name}
            {!l.open && ` · ${t('dep_closed')}`}
            <button type="button" className="chip-x" disabled={busy} aria-label={`${t('remove')} ${l.code}`} onClick={() => save(ids.filter((x) => x !== l.id))}>
              ×
            </button>
          </span>
        ))}
        <select className="select" style={{ width: 'auto', minWidth: 240 }} disabled={busy} aria-label={t('dep_label')} value="" onChange={(e) => e.target.value && save([...ids, Number(e.target.value)])}>
          <option value="">{t('dep_add')}</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </div>
      <span className="hint">{t('dep_hint')}</span>
    </div>
  );
}
