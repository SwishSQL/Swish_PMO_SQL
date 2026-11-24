import { CheckCircle, Circle, DownloadSimple, FileText, ListChecks, LockSimple, X } from '@phosphor-icons/react';
import type { ProjectDetail } from '../../shared/types';
import { useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/format';
import { Dialog, Drawer } from './ui';

// The closure documents milestone has its own panel: nothing on it is typed. It shows where the closure stands
// (milestones, documents, PMO approval), what to prepare, the two templates, and the button that asks to close.

/** Asks the closure bar of the project page to open its request (or, for the PMO, its close) dialog. */
export const askClosure = () => window.dispatchEvent(new Event('pmo:closure-ask'));

/** Open regular milestones: the closure documents milestone never counts. */
export const openMilestonesOf = (d: ProjectDetail) =>
  d.tasks.filter((x) => x.kind === 'milestone' && !x.notRequired && x.status !== 'done' && x.status !== 'cancelled' && x.systemKey !== 'closure_docs').length;

/** The two documents, each with what it holds and its template. */
export function ClosureDocList() {
  const { t } = useT();
  const docs = [
    { icon: FileText, title: t('cd_report'), note: t('cd_reportNote'), href: '/api/templates/closure-report' },
    { icon: ListChecks, title: t('cd_checklist'), note: t('cd_checklistNote'), href: '/api/templates/sign-off-checklist' },
  ];
  return (
    <div className="cd-docs">
      {docs.map(({ icon: Icon, title, note, href }) => (
        <div key={href} className="cd-doc">
          <Icon size={22} weight="duotone" aria-hidden />
          <div>
            <strong>{title}</strong>
            <p>{note}</p>
            <a className="btn btn-sm" href={href} download>
              <DownloadSimple size={14} aria-hidden /> {t('cd_template')}
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ClosureDocsPanel({ detail, canGovern, canClose, onClose }: { detail: ProjectDetail; canGovern: boolean; canClose: boolean; onClose: () => void }) {
  const { t, lang } = useT();
  const all = detail.tasks.filter((x) => x.kind === 'milestone' && !x.notRequired && x.status !== 'cancelled' && x.systemKey !== 'closure_docs');
  const open = openMilestonesOf(detail);
  const c = detail.closure;
  const closed = detail.project.health === 'done';
  const pending = c?.status === 'pending';
  const steps: { label: string; note?: string; state: 'done' | 'now' | 'later' }[] = [
    { label: t('cd_step1'), note: t('cd_step1Note', { d: all.length - open, n: all.length }), state: open === 0 ? 'done' : 'now' },
    {
      label: t('cd_step2'),
      note: pending && c ? t('cd_pendingNote', { d: fmtDateTime(c.createdAt, lang) }) : undefined,
      state: pending || closed ? 'done' : open === 0 ? 'now' : 'later',
    },
    { label: t('cd_step3'), state: closed ? 'done' : pending ? 'now' : 'later' },
  ];
  const ready = open === 0 && !pending && !closed;
  const go = () => {
    onClose();
    askClosure();
  };
  return (
    <Drawer onClose={onClose} label={t('cd_title')}>
      <div className="dialog-head" style={{ paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
        <div>
          <div className="code">{t('kind_milestone')}</div>
          <h2 className="dialog-title" style={{ marginTop: 2 }}>
            {t('cd_title')}
          </h2>
        </div>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={t('close')}>
          <X size={16} />
        </button>
      </div>
      <div className="dialog-body cd-panel" style={{ flex: 1 }}>
        <p className="cd-intro">{t('cd_intro')}</p>

        <ol className="cd-steps">
          {steps.map((s, i) => (
            <li key={i} className={`cd-step is-${s.state}`}>
              {s.state === 'done' ? <CheckCircle size={20} weight="fill" aria-hidden /> : <Circle size={20} weight={s.state === 'now' ? 'bold' : 'regular'} aria-hidden />}
              <div>
                <span>{s.label}</span>
                {s.note && <small>{s.note}</small>}
              </div>
              <em>{s.state === 'done' ? t('cd_done') : s.state === 'now' ? t('cd_now') : t('cd_waiting')}</em>
            </li>
          ))}
        </ol>

        <h3 className="cd-h">{t('cd_docs')}</h3>
        <ClosureDocList />

        <p className="cd-lock">
          <LockSimple size={14} aria-hidden /> {t('cd_auto')}
        </p>
      </div>
      {!closed && !pending && (
        <div className="dialog-foot" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 13 }}>
            {!canGovern ? t('cd_byOwner') : !ready ? t('cd_notYet') : ''}
          </span>
          {canGovern && (
            <button className="btn btn-primary" disabled={!ready} onClick={go}>
              {canClose ? t('closureCloseNow') : t('cd_request')}
            </button>
          )}
        </div>
      )}
    </Drawer>
  );
}

/** Shown once, the moment the last milestone is done: closing is next, and these are the documents it needs. */
export function AllDoneDialog({ canClose, onClose }: { canClose: boolean; onClose: () => void }) {
  const { t } = useT();
  return (
    <Dialog
      title={t('cd_allDoneTitle')}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('cd_later')}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onClose();
              askClosure();
            }}
          >
            {canClose ? t('closureCloseNow') : t('cd_requestNow')}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{t('cd_allDoneBody')}</p>
      <ClosureDocList />
    </Dialog>
  );
}
