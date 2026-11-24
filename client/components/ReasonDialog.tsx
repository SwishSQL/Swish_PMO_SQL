import { useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { useT } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { Dialog, Field } from './ui';
import { MentionTextarea } from './MentionTextarea';

/**
 * A milestone's deadline is a commitment, so moving it asks why. The answer is kept with the move
 * (who, when, from, to). For a team member the move then waits for the project manager or the PMO.
 */
export function ReasonDialog({
  name,
  from,
  to,
  needsApproval,
  onConfirm,
  onCancel,
}: {
  name: string;
  from: string;
  to: string;
  needsApproval: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const { t, lang } = useT();
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 5;
  return (
    <Dialog
      title={t('moveDeadlineTitle')}
      onClose={onCancel}
      width={500}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={!ok} onClick={() => onConfirm(reason.trim())}>
            {t('moveDeadline')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <div style={{ fontWeight: 500 }}>{name}</div>
          <div className="date-move num">
            <span>{fmtDate(from, lang, true)}</span>
            <ArrowRight size={14} aria-hidden style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} />
            <strong>{fmtDate(to, lang, true)}</strong>
          </div>
        </div>
        <Field label={t('whyMoved')} hint={needsApproval ? t('whyMovedPending') : t('whyMovedHint')}>
          <MentionTextarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
