import { useState } from 'react';
import { Copy, Robot } from '@phosphor-icons/react';
import type { AiPmEntry, ProjectDetail } from '../../shared/types';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/format';
import { Dialog } from './ui';

// The AI project manager on a project: one switch for whoever runs it (or the PMO), and what it has done.

export function AiPmBar({ detail, canGovern, onChanged }: { detail: ProjectDetail; canGovern: boolean; onChanged: () => void }) {
  const { t } = useT();
  const { can } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const p = detail.project as typeof detail.project & { aiPmEnabled?: boolean; aiPmSince?: string | null };
  const pmo = can('projects.edit_all');
  if (!canGovern && !pmo) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      await api.put(`/api/projects/${p.id}/ai-pm`, { enabled: !p.aiPmEnabled });
      toast(p.aiPmEnabled ? t('ai_off') : t('ai_on'));
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className={`ai-pm-bar ${p.aiPmEnabled ? 'is-on' : ''}`}>
        <Robot size={18} aria-hidden />
        <span className="ai-pm-text">
          <strong>{t('ai_title')}</strong> {p.aiPmEnabled ? t('ai_onSince', { d: fmtDateTime(p.aiPmSince ?? '', 'en') }) : t('ai_offHint')}
        </span>
        {p.aiPmEnabled && (
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
            {t('ai_activity')}
          </button>
        )}
        <button className={`btn btn-sm ${p.aiPmEnabled ? '' : 'btn-primary'}`} disabled={busy} onClick={toggle}>
          {p.aiPmEnabled ? t('ai_turnOff') : t('ai_turnOn')}
        </button>
      </div>
      {open && <AiPmLog projectId={p.id} onClose={() => setOpen(false)} />}
    </>
  );
}

function AiPmLog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const { data } = useLoad(() => api.get<AiPmEntry[]>(`/api/projects/${projectId}/ai-pm`), [projectId]);
  return (
    <Dialog title={t('ai_activity')} onClose={onClose} width={680}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        {t('ai_rules')}
      </p>
      {!data ? (
        <p className="muted">…</p>
      ) : data.length === 0 ? (
        <p className="muted">{t('ai_nothingYet')}</p>
      ) : (
        <ol className="update-log">
          {data.map((e) => (
            <li key={e.id}>
              <div className="update-log-meta">
                <strong>{t(`ai_act_${e.action}` as never) || e.action}</strong>
                <span className="num">{fmtDateTime(e.createdAt, lang)}</span>
              </div>
              <p style={{ whiteSpace: 'pre-wrap' }}>{e.message.replace(/^\[[^\]]+\]\s*/, '')}</p>
              {e.action === 'weekly_draft' && (
                <button
                  className="btn btn-sm"
                  onClick={() => navigator.clipboard?.writeText(e.message).then(() => toast(t('ai_copied'))).catch(() => undefined)}
                >
                  <Copy size={14} aria-hidden /> {t('ai_copyDraft')}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
