import { Fragment, useMemo, useState } from 'react';
import type { PersonInsight } from '../../shared/types';
import { api } from '../api';
import { useLoad } from '../lib/app';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { ErrorState, PageSkeleton, Segmented } from '../components/ui';
import { LearnMore } from '../components/Tour';

// Engagement & delivery insights, for the PMO: per person, from what the system records. Coaching and appraisal
// input, never a personality label. People see only their own indicator, on their home page.

export function Insights() {
  const { t } = useT();
  const [days, setDays] = useState<'30' | '90' | '180'>('90');
  const [dept, setDept] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const { data, error, reload } = useLoad(() => api.get<PersonInsight[]>(`/api/insights?days=${days}`), [days]);
  const rows = useMemo(
    () => (data ?? []).filter((p) => !dept || p.department === dept).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.items - a.items),
    [data, dept],
  );
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;
  const depts = [...new Set(data.map((p) => p.department).filter(Boolean))].sort() as string[];
  const top = rows.filter((p) => p.score !== null).slice(0, 5);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('in_title')}</h1>
          <LearnMore page="insights" />
          <p className="page-sub">{t('in_sub')}</p>
        </div>
      </div>
      <div className="filters">
        <Segmented
          label={t('in_period')}
          value={days}
          onChange={setDays}
          options={[
            { value: '30', label: t('in_30') },
            { value: '90', label: t('in_90') },
            { value: '180', label: t('in_180') },
          ]}
        />
        <select className="select" style={{ width: 'auto' }} value={dept} aria-label={t('responsibleDept')} onChange={(e) => setDept(e.target.value)}>
          <option value="">{t('allDepartments')}</option>
          {depts.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      </div>
      {top.length > 0 && (
        <section className="panel" style={{ marginBottom: 12 }}>
          <div className="panel-body">
            <strong>{t('in_top')}</strong>
            <div className="in-top">
              {top.map((p, i) => (
                <span key={p.userId} className="flag-chip ok">
                  {i + 1}. {p.name} · {p.score}
                </span>
              ))}
            </div>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="perm-matrix-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('in_person')}</th>
                <th className="num">{t('in_load')}</th>
                <th className="num">{t('in_items')}</th>
                <th className="num">{t('in_onTime')}</th>
                <th className="num">{t('in_updates')}</th>
                <th className="num">{t('in_reply')}</th>
                <th className="num">{t('in_delay')}</th>
                <th className="num">{t('in_score')}</th>
                <th>{t('in_signal')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <Fragment key={p.userId}>
                  <tr className="clickable" onClick={() => setOpen(open === p.userId ? null : p.userId)}>
                    <td>
                      <strong>{p.name}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {[p.title, p.department].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="num">{p.load}</td>
                    <td className="num">{p.items}</td>
                    <td className="num">{p.items ? `${p.onTimePct}%` : '-'}</td>
                    <td className="num">{p.items ? `${p.updatesOnTimePct}%` : '-'}</td>
                    <td className="num">{p.replyDays === null ? '-' : `${p.replyDays} d`}</td>
                    <td className="num" style={{ color: p.delayCausedDays ? 'var(--bad)' : undefined }}>
                      {p.delayCausedDays ? `${p.delayCausedDays} d` : '-'}
                    </td>
                    <td className="num">{p.score ?? '-'}</td>
                    <td>
                      <span className={`flag-chip in-${p.label}`}>{t(`in_label_${p.label}` as TKey)}</span>
                      {p.tip && <div className="muted" style={{ fontSize: 12 }}>{t(`in_tip_${p.tip}` as TKey)}</div>}
                    </td>
                  </tr>
                  {open === p.userId && (
                    <tr key={`${p.userId}-more`}>
                      <td colSpan={9} className="muted" style={{ whiteSpace: 'normal' }}>
                        {p.summary}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="muted" style={{ fontSize: 12.5 }}>
        {t('in_rules')}
      </p>
    </div>
  );
}

/** My own indicator, on my home page: one label and one tip. */
export function MyIndicator() {
  const { t } = useT();
  const { data } = useLoad(() => api.get<{ label: PersonInsight['label']; tip: PersonInsight['tip'] }>('/api/insights/me'), [], 'my-indicator');
  if (!data || data.label === 'not_enough') return null;
  return (
    <div className={`my-indicator in-${data.label}`} role="status">
      <strong>{t('in_mine')}</strong> <span className={`flag-chip in-${data.label}`}>{t(`in_label_${data.label}` as TKey)}</span>
      {data.tip && <span className="muted"> · {t(`in_tipMine_${data.tip}` as TKey)}</span>}
    </div>
  );
}
