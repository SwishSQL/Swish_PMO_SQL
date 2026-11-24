import { useState } from 'react';
import { useT } from '../lib/i18n';
import { Dialog, Field } from './ui';
import { MentionTextarea } from './MentionTextarea';

/**
 * Completing a milestone is a commitment, and reopening one undoes it: both ask first. Completing can carry a
 * note (who signed it off, what was delivered), kept as the milestone's latest update.
 */
export function ConfirmDone({
  name,
  project,
  reopen,
  askNote = true,
  onConfirm,
  onCancel,
}: {
  name: string;
  project?: string;
  reopen: boolean;
  /** False when the person already wrote an update with it. */
  askNote?: boolean;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [note, setNote] = useState('');
  return (
    <Dialog
      title={t(reopen ? 'reopenTitle' : 'completeTitle')}
      onClose={onCancel}
      width={480}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" autoFocus={reopen || !askNote} onClick={() => onConfirm(note.trim())}>
            {t(reopen ? 'reopenConfirm' : 'completeConfirm')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{name}</div>
          {project && <div className="code">{project}</div>}
          <p className="ink-2" style={{ margin: '8px 0 0', fontSize: 14 }}>
            {t(reopen ? 'reopenBody' : 'completeBody')}
          </p>
        </div>
        {!reopen && askNote && (
          <Field label={t('completeNote')} hint={t('completeNoteHint')}>
            <MentionTextarea
              className="textarea"
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onConfirm(note.trim());
                }
              }}
            />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
