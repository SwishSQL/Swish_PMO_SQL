import { useEffect, useRef, useState } from 'react';
import { DownloadSimple, Paperclip, Trash } from '@phosphor-icons/react';
import { api } from '../api';
import { useApp, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/format';

// The files attached to a milestone or task: any kind, up to 8 MB each. Each one opens as a download.

interface Attachment {
  id: number;
  name: string;
  size: number;
  uploadedBy: number | null;
  uploadedByName: string | null;
  createdAt: string;
}

const MAX = 8 * 1024 * 1024;
const sizeLabel = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function TaskAttachments({ taskId, canAttach, canGovern }: { taskId: number; canAttach: boolean; canGovern: boolean }) {
  const { meta } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setFiles(null);
    api
      .get<Attachment[]>(`/api/tasks/${taskId}/attachments`)
      .then((rows) => live && setFiles(rows))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [taskId]);

  const upload = async (list: FileList | null) => {
    const chosen = Array.from(list ?? []);
    if (input.current) input.current.value = '';
    if (!chosen.length) return;
    setBusy(true);
    for (const file of chosen) {
      if (file.size > MAX) {
        toast(t('attachTooBig', { name: file.name }), 'bad');
        continue;
      }
      if (file.size === 0) {
        toast(t('attachEmpty', { name: file.name }), 'bad');
        continue;
      }
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
          r.onerror = () => reject(new Error(t('attachReadFailed', { name: file.name })));
          r.readAsDataURL(file);
        });
        const added = await api.post<Attachment>(`/api/tasks/${taskId}/attachments`, { name: file.name, data });
        setFiles((f) => [added, ...(f ?? [])]);
        toast(t('attachAdded', { name: file.name }));
      } catch (e) {
        toast((e as Error).message, 'bad');
      }
    }
    setBusy(false);
  };

  const remove = async (a: Attachment) => {
    if (!window.confirm(t('attachRemoveConfirm', { name: a.name }))) return;
    try {
      await api.del(`/api/attachments/${a.id}`);
      setFiles((f) => (f ?? []).filter((x) => x.id !== a.id));
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  return (
    <section className="attachments" aria-label={t('attachments')}>
      <div className="attachments-head">
        <strong>
          {t('attachments')}
          {files && files.length > 0 ? ` (${files.length})` : ''}
        </strong>
        {canAttach && (
          <>
            <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
              <Paperclip size={14} aria-hidden />
              {busy ? t('attachUploading') : t('attachFile')}
            </button>
          </>
        )}
      </div>
      {files === null ? (
        <div className="muted" style={{ fontSize: 13 }}>…</div>
      ) : files.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>{t('attachNone')}</div>
      ) : (
        <ul className="attachments-list">
          {files.map((a) => (
            <li key={a.id}>
              <a href={`/api/attachments/${a.id}`} download={a.name} className="attachment-link" title={t('attachDownload')}>
                <DownloadSimple size={15} aria-hidden />
                <span className="attachment-name" dir="auto">{a.name}</span>
              </a>
              <span className="muted attachment-meta">
                {sizeLabel(a.size)} · {a.uploadedByName ?? '—'} · {fmtDateTime(a.createdAt, lang)}
              </span>
              {(canGovern || (canAttach && a.uploadedBy === meta.me.id)) && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(a)} aria-label={t('attachRemove', { name: a.name })} title={t('attachRemove', { name: a.name })}>
                  <Trash size={14} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
