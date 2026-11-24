import { useState } from 'react';
import { api } from '../api';
import { navigate, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { Dialog, Field } from './ui';

/** Deleting a project for good: PMO admins only, with the reason, which stays in the activity log. */
export function DeleteProject({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 5;
  const remove = async () => {
    setBusy(true);
    try {
      await api.post(`/api/projects/${id}/delete`, { reason: reason.trim() });
      toast(t('projectDeleted'));
      navigate('/portfolio');
    } catch (e) {
      toast((e as Error).message, 'bad');
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('deleteProjectTitle')}
      onClose={onClose}
      width={500}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary btn-danger-solid" disabled={!ok || busy} onClick={remove}>
            {t('deleteForever')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{name}</div>
          <p className="ink-2" style={{ margin: '8px 0 0', fontSize: 14 }}>
            {t('deleteProjectBody')}
          </p>
        </div>
        <Field label={t('deleteReason')} hint={t('deleteReasonHint')}>
          <textarea className="textarea" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
