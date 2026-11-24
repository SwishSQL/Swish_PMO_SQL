import { useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import type { Health, StatusUpdate } from '../../shared/types';
import { api } from '../api';
import { useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { Dialog, Field, HealthIcon } from './ui';
import { MentionTextarea } from './MentionTextarea';

const CHOICES: Health[] = ['on_track', 'at_risk', 'off_track'];

export function UpdateDialog({
  projectId,
  projectLabel,
  week,
  existing,
  planProgress,
  currentHealth,
  onClose,
  onSaved,
}: {
  projectId: number;
  projectLabel: string;
  week: string;
  existing?: StatusUpdate | null;
  planProgress: number;
  currentHealth: Health;
  onClose: () => void;
  onSaved: (u: StatusUpdate) => void;
}) {
  const { t, lang } = useT();
  const [health, setHealth] = useState<Health>(
    existing?.health ?? (CHOICES.includes(currentHealth) ? currentHealth : 'on_track'),
  );
  // The % comes from the plan (milestones and tasks), not from this form.
  const progress = planProgress;
  const [accomplishments, setAccomplishments] = useState(existing?.accomplishments ?? '');
  const [nextSteps, setNextSteps] = useState(existing?.nextSteps ?? '');
  const [blockers, setBlockers] = useState(existing?.blockers ?? '');
  const [decisions, setDecisions] = useState(existing?.decisions ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ai = useLoad(() => api.get<{ enabled: boolean }>('/api/ai/status'), [], 'ai-status');
  const toast = useToast();
  const [drafting, setDrafting] = useState(false);

  // The first draft from what was reported on the milestones this week. It only fills the boxes: the manager edits and saves.
  const draft = async () => {
    setDrafting(true);
    setError(null);
    try {
      const d = await api.post<{ health: Health; accomplishments: string; nextSteps: string; blockers: string; decisions: string; basedOn: number }>(`/api/ai/weekly-draft/${projectId}`);
      setAccomplishments(d.accomplishments);
      setNextSteps(d.nextSteps);
      setBlockers(d.blockers);
      if (d.decisions) setDecisions(d.decisions);
      toast(t('draftReady', { n: d.basedOn }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const u = await api.put<StatusUpdate>(`/api/projects/${projectId}/updates/${week}`, {
        health,
        progress,
        accomplishments,
        nextSteps,
        blockers,
        decisions,
      });
      onSaved(u);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={
        <>
          {existing ? t('editUpdate') : t('writeUpdate')}
          <div className="code" style={{ fontWeight: 400, marginTop: 2 }}>
            {projectLabel}. {t('weekOf', { d: fmtDate(week, lang, true) })}
          </div>
        </>
      }
      onClose={onClose}
      width={720}
      footer={
        <>
          {error && (
            <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !accomplishments.trim()}>
            {t('save')}
          </button>
        </>
      }
    >
      {ai.data?.enabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={draft} disabled={drafting || busy}>
            <Sparkle size={15} weight="fill" aria-hidden />
            {drafting ? t('drafting') : t('draftWithAi')}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>{t('draftHint')}</span>
        </div>
      )}
      <div className="form-grid">
        <div className="field">
          <span>{t('health')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span className={`pill h-${currentHealth}`}>
              <HealthIcon health={currentHealth} size={14} /> {t(`health_${currentHealth}`)}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>{t('healthFromPlan')}</span>
          </div>
        </div>
        <Field label={`${t('progress')} ${progress}%`} hint={t('progressFromPlan')}>
          <div className="meter" style={{ marginTop: 12 }} aria-hidden>
            <i style={{ width: `${progress}%` }} />
          </div>
        </Field>
        <Field label={t('accomplishments')} className="span-2">
          <MentionTextarea className="textarea" value={accomplishments} onChange={(e) => setAccomplishments(e.target.value)} />
        </Field>
        <Field label={t('nextSteps')}>
          <MentionTextarea className="textarea" value={nextSteps} onChange={(e) => setNextSteps(e.target.value)} />
        </Field>
        <Field label={t('blockers')}>
          <MentionTextarea className="textarea" value={blockers} onChange={(e) => setBlockers(e.target.value)} />
        </Field>
        <Field label={t('decisions')} hint={t('decisionsHint')} className="span-2">
          <MentionTextarea className="textarea" style={{ minHeight: 64 }} value={decisions} onChange={(e) => setDecisions(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
