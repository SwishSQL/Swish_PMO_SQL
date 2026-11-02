import { GitPullRequest } from '@phosphor-icons/react';
import type { ChangeRequest } from '../../shared/types';
import { api } from '../api';
import { useLoad } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/format';
import { stagger } from '../lib/motion';
import { StatusChip } from './ChangesTab';

type Waiting = ChangeRequest & { projectCode: string; projectName: string };

/**
 * The change requests waiting for this person's decision: as head of a project's department, or as a PMO approver.
 * Shown on the Dashboard, and only while something waits.
 */
export function ChangeQueue() {
  const { t, lang } = useT();
  const { data } = useLoad(() => api.get<Waiting[]>('/api/change-requests/pending'), [], 'changes-pending');
  if (!data || data.length === 0) return null;
  return (
    <section className="panel closure-queue" aria-label={t('cr_queueTitle')}>
      <div className="panel-head">
        <h2 className="panel-title">
          <GitPullRequest size={18} weight="duotone" aria-hidden /> {t('cr_queueTitle')}
        </h2>
        <span className="muted">{t('cr_queueHint')}</span>
      </div>
      <ul className="closure-list">
        {data.map((c, i) => (
          <li key={c.id} className="enter" style={stagger(i)}>
            <div className="closure-main">
              <a href={`#/projects/${c.projectId}/changes`}>
                <strong>
                  {c.code} · {c.projectName}
                </strong>
              </a>
              <span className="code">{c.projectCode}</span>
              <div className="muted" style={{ fontSize: 13 }}>
                {c.requestedByName} · {fmtDateTime(c.requestedAt, lang)} · {c.areas.map((a) => t(`cr_area_${a}`)).join(', ')}
              </div>
              <div style={{ fontSize: 13.5 }} dir="auto">
                {c.description}
              </div>
            </div>
            <div className="toolbar">
              <StatusChip c={c} />
              <a className="btn btn-sm btn-primary" href={`#/projects/${c.projectId}/changes`}>
                {t('cr_review')}
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
