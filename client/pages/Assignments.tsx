import { useState } from 'react';
import { Check, UserPlus, X } from '@phosphor-icons/react';
import type { OwnerRequest } from '../../shared/types';
import { api } from '../api';
import { useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { Empty, ErrorState, PageSkeleton } from '../components/ui';
import { LearnMore } from '../components/Tour';

// Owners asked of this person: the head of a department picks or approves someone of their team for a milestone of
// another department's project; a system admin creates the account of someone new. Approving gives them the work.

export function Assignments() {
  const { t, lang } = useT();
  const { data, error, reload } = useLoad(() => api.get<OwnerRequest[]>('/api/owner-requests/inbox'), []);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('as_title')}</h1>
          <LearnMore page="assign" />
          <p className="page-sub">{t('as_sub')}</p>
        </div>
      </div>
      {data.length === 0 ? (
        <Empty title={t('as_empty')} body={t('as_emptyBody')} />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {data.map((r) => (
            <RequestCard key={r.id} r={r} lang={lang} onDone={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestCard({ r, lang, onDone }: { r: OwnerRequest; lang: 'en' | 'ar'; onDone: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [pick, setPick] = useState<number | ''>(r.userId ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(true);
    try {
      await api.post(`/api/owner-requests/${r.id}/decide`, { decision, userId: pick || undefined, note: note.trim() || undefined });
      toast(decision === 'approve' ? t('as_approved') : t('as_declined'));
      onDone();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const ask =
    r.kind === 'new'
      ? t('as_askNew', { name: r.userName ?? '', email: r.newEmail ?? '', dept: r.departmentName })
      : r.kind === 'person'
        ? t('as_askPerson', { name: r.userName ?? '' })
        : t('as_askDept', { dept: r.departmentName });
  return (
    <section className="panel">
      <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <UserPlus size={20} aria-hidden style={{ color: 'var(--accent)', marginTop: 2, flex: 'none' }} />
          <div style={{ minWidth: 0 }}>
            <strong>{r.taskName}</strong>
            <div className="muted" style={{ fontSize: 13 }}>
              {r.projectCode} · {r.projectName}
            </div>
            <p style={{ margin: '6px 0 0' }}>{ask}</p>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {t('as_by', { name: r.requestedBy ?? '-', date: fmtDate(r.requestedAt.slice(0, 10), lang, true) })}
              {r.note ? ` · ${r.note}` : ''}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {r.kind !== 'new' && (
            <select className="select" style={{ maxWidth: 280 }} aria-label={t('as_pick')} value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')}>
              <option value="">{t('as_pick')}</option>
              {(r.candidates ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <input className="input" style={{ maxWidth: 320 }} placeholder={t('as_note')} aria-label={t('as_note')} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || (r.kind !== 'new' && !pick)} onClick={() => decide('approve')}>
            <Check size={15} weight="bold" aria-hidden />
            {r.kind === 'new' ? t('as_createAssign') : t('as_assign')}
          </button>
          <button className="btn" disabled={busy} onClick={() => decide('decline')}>
            <X size={15} aria-hidden />
            {t('as_decline')}
          </button>
        </div>
      </div>
    </section>
  );
}
