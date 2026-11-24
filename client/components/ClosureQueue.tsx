import { useState } from 'react';
import { SealCheck } from '@phosphor-icons/react';
import { api } from '../api';
import { useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDateTime, projectName } from '../lib/format';
import { stagger } from '../lib/motion';
import { Dialog, Field } from './ui';
import { DeliveryDoc } from './DeliveryDoc';
import { MentionTextarea } from './MentionTextarea';

interface Pending {
  id: number;
  projectId: number;
  projectCode: string;
  projectName: string;
  projectNameAr: string | null;
  progress: number;
  openMilestones: number;
  note: string;
  deliveryUrl: string | null;
  deliveryFileName: string | null;
  reportFileName: string | null;
  checklistFileName: string | null;
  requestedByName: string | null;
  createdAt: string;
}

/**
 * The projects whose owners say they are finished, for the people who approve closing. Shown on the
 * Dashboard to them only, and only while something waits.
 */
export function ClosureQueue() {
  const { t, lang } = useT();
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<Pending[]>('/api/closure-requests/pending'), [], 'closure-pending');
  const [deciding, setDeciding] = useState<{ p: Pending; decision: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!data || data.length === 0) return null;

  const decide = async () => {
    if (!deciding) return;
    setBusy(true);
    try {
      await api.post(`/api/closure-requests/${deciding.p.id}/decide`, { decision: deciding.decision, note });
      setDeciding(null);
      setNote('');
      reload();
      toast(t('saved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel closure-queue" aria-label={t('closureQueueTitle')}>
      <div className="panel-head">
        <h2 className="panel-title">
          <SealCheck size={18} weight="duotone" aria-hidden /> {t('closureQueueTitle')}
        </h2>
        <span className="muted">{t('closureQueueHint')}</span>
      </div>
      <ul className="closure-list">
        {data.map((p, i) => (
          <li key={p.id} className="enter" style={stagger(i)}>
            <div className="closure-main">
              <a href={`#/projects/${p.projectId}`}>
                <strong>{projectName({ name: p.projectName, nameAr: p.projectNameAr }, lang)}</strong>
              </a>
              <span className="code">{p.projectCode}</span>
              <div className="muted" style={{ fontSize: 13 }}>
                {p.requestedByName} · {fmtDateTime(p.createdAt, lang)} · {p.progress}% ·{' '}
                {p.openMilestones > 0 ? t('closureOpenMilestones', { n: p.openMilestones }) : t('closureAllMilestones')}
              </div>
              {p.note && <div style={{ fontSize: 13.5 }}>{p.note}</div>}
              <div style={{ fontSize: 13.5 }}>
                <DeliveryDoc requestId={p.id} url={p.deliveryUrl} fileName={p.deliveryFileName} reportFileName={p.reportFileName} checklistFileName={p.checklistFileName} />
              </div>
            </div>
            <div className="toolbar">
              <button className="btn btn-sm btn-primary" onClick={() => setDeciding({ p, decision: 'approve' })}>
                {t('closureApprove')}
              </button>
              <button className="btn btn-sm" onClick={() => setDeciding({ p, decision: 'reject' })}>
                {t('closureReject')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {deciding && (
        <Dialog
          title={`${deciding.decision === 'approve' ? t('closureApprove') : t('closureReject')}: ${deciding.p.projectCode}`}
          onClose={() => setDeciding(null)}
          width={520}
          footer={
            <>
              <button className="btn" onClick={() => setDeciding(null)}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={decide}>
                {t('save')}
              </button>
            </>
          }
        >
          <Field label={t('closureDecisionNote')}>
            <MentionTextarea className="input" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </Dialog>
      )}
    </section>
  );
}
