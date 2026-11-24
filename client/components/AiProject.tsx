import { useEffect, useRef, useState } from 'react';
import { PaperPlaneRight, Plus, Sparkle, Trash, Warning } from '@phosphor-icons/react';
import type { DraftAnswer, ProjectDetail, ProjectDraft } from '../../shared/types';
import { PRIORITIES } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../lib/app';
import { useT } from '../lib/i18n';
import { deptName } from '../lib/format';
import { Dialog, Field } from './ui';
import { PROJECT_PHASES } from '../../shared/phases';
import { STAGE_FIELDS, missingForCreation } from '../../shared/stageRequirements';
import { DateInput } from './DateInput';
import type { ProjectPreset } from './NewProject';
import { SponsorSelect } from './SponsorSelect';
import { PeoplePicker } from './PeoplePicker';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** The assistant's questions about what is still missing, shown as a list under its reply. */
  questions?: string[];
}

const EMPTY: ProjectDraft = {
  name: '',
  nameAr: '',
  departmentId: 0,
  ownerId: 0,
  sponsor: '',
  priority: 'medium',
  objective: '',
  scope: '',
  problemStatement: '',
  stakeholders: '',
  businessCase: '',
  budget: '',
  resources: '',
  riskPlan: '',
  deliverables: '',
  successMetric: '',
  successTarget: '',
  acceptanceCriteria: '',
  startDate: '',
  endDate: '',
  phases: [...PROJECT_PHASES],
  milestones: [],
};

/**
 * Starting a project by chatting: the person says what it is, the assistant fills in a draft beside the chat
 * (name, department, owner, dates, milestones), and every field stays editable. Nothing exists until the person
 * presses Create, which goes through the normal creation with the normal rules.
 */
export function AiProjectDialog({ onClose, onCreated, preset }: { onClose: () => void; onCreated: (id: number) => void; preset?: ProjectPreset }) {
  const { meta, quarterId, canCreateIn, can } = useApp();
  const { t, lang } = useT();
  // A project manager starts a plan project in any department, and runs it.
  const planOnly = !meta.departments.some((d) => canCreateIn(d.id)) && can('projects.start_plan');
  const allowed = planOnly ? meta.departments : meta.departments.filter((d) => canCreateIn(d.id));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    preset
      ? {
          ...EMPTY,
          name: preset.name,
          objective: preset.objective ?? '',
          successMetric: preset.successMetric ?? '',
          successTarget: preset.successTarget ?? '',
          acceptanceCriteria: preset.acceptanceCriteria ?? '',
        }
      : EMPTY,
  );
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // Seconds waited on the current answer, shown in the chat so the wait is never a silent spinner.
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setWaited(0);
    const timer = window.setInterval(() => setWaited((w) => w + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const set = <K extends keyof ProjectDraft>(k: K, v: ProjectDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, busy]);

  const send = async (said: string) => {
    const content = said.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content }];
    setTurns(next);
    setText('');
    setBusy(true);
    setError(null);
    try {
      // The draft as it stands now goes along, so the person's own edits are respected.
      // The questions travel back inside the assistant's turn, so it remembers what it already asked.
      const messages = next.map((m) => ({
        role: m.role,
        content: m.questions?.length ? [m.content, ...m.questions.map((q) => `- ${q}`)].join('\n') : m.content,
      }));
      const a = await api.post<DraftAnswer>('/api/ai/project-draft', { messages, draft: turns.length || draft.name ? draft : null });
      setDraft(a.draft);
      setAssumptions(a.assumptions);
      if (a.reply || a.questions.length) setTurns((tt) => [...tt, { role: 'assistant', content: a.reply || t('aiNeedMore'), questions: a.questions }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // From a plan project: the assistant is told what the workbook says, once, and drafts from there.
  const seeded = useRef(false);
  useEffect(() => {
    if (!preset || seeded.current) return;
    seeded.current = true;
    void send(`${t('aiFromPlan', { name: preset.name })}\n\n${preset.context ?? ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const datesOk = Boolean(draft.startDate && draft.endDate && draft.endDate >= draft.startDate);
  const milestonesOk = draft.milestones.every((m) => !m.name.trim() || m.date);
  const ready = Boolean(draft.name.trim() && draft.departmentId && datesOk && milestonesOk);
  // What a complete project still lacks, by the same rules as the server, so nothing is missed even if the
  // assistant forgets to ask; Create opens only when nothing is.
  const stageMissing = missingForCreation({ ...draft, milestones: draft.milestones.filter((m) => m.name.trim()) }, lang === 'ar' ? 'ar' : 'en');
  const stillNeeded = [
    !draft.name.trim() && t('name'),
    !draft.departmentId && t('department'),
    !planOnly && !draft.ownerId && t('manager'),
    !datesOk && `${t('start')} / ${t('finish')}`,
    !draft.sponsor.trim() && t('sponsor'),
    ...stageMissing.map((m) => `${m.phase}: ${m.items.join(', ')}`),
  ].filter(Boolean) as string[];

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const detail = await api.post<ProjectDetail>('/api/projects', {
        ...draft,
        // The draft calls the owner ownerId; the normal creation calls it managerId. Empty means the default.
        managerId: draft.ownerId || undefined,
        quarterId: quarterId ?? null,
        milestones: draft.milestones.filter((m) => m.name.trim() && m.date),
        ...(preset ? { initiativeId: preset.initiativeId } : {}),
      });
      onCreated(detail.project.id);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  const examples = [t('aiExample1'), t('aiExample2'), t('aiExample3')];
  const started = turns.length > 0;

  return (
    <Dialog
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Sparkle size={20} weight="fill" aria-hidden /> {t('aiTitle')}
        </span>
      }
      onClose={onClose}
      width={1080}
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
          <button className="btn btn-primary" disabled={!ready || stillNeeded.length > 0 || creating || busy} onClick={create}>
            {t('aiCreateProject')}
          </button>
        </>
      }
    >
      <div className="ai-grid">
        <section className="ai-chat" aria-label={t('aiChat')}>
          <div className="ai-log" ref={logRef} aria-live="polite">
            {!started && (
              <div className="ai-intro">
                <p>{t('aiIntro')}</p>
                <div className="ai-examples">
                  {examples.map((x) => (
                    <button key={x} className="chip" onClick={() => setText(x)}>
                      {x}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((m, i) => (
              <div key={i} className={`ai-msg ${m.role}`} dir="auto">
                {/* A pasted plan can be pages long: the chat shows its start, the assistant read all of it. */}
                {m.role === 'user' && m.content.length > 600 ? `${m.content.slice(0, 400).trim()}…
(${t('aiPasted', { n: m.content.length })})` : m.content}
                {m.questions && m.questions.length > 0 && (
                  <ol className="ai-questions">
                    {m.questions.map((q, j) => (
                      <li key={j}>{q}</li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
            {busy && (
              <div className="ai-msg assistant ai-busy">
                {t('aiThinking')} <span className="num">{waited > 0 ? `${waited}s` : ''}</span>
              </div>
            )}
          </div>
          <form
            className="ai-input"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <textarea
              className="input"
              rows={2}
              value={text}
              dir="auto"
              placeholder={started ? t('aiFollowUp') : t('aiPlaceholder')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(text);
                }
              }}
              aria-label={t('aiChat')}
            />
            <button className="btn btn-primary btn-icon" type="submit" disabled={busy || !text.trim()} aria-label={t('aiSend')} title={t('aiSend')}>
              <PaperPlaneRight size={18} weight="fill" style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} />
            </button>
          </form>
        </section>

        <section className="ai-draft" aria-label={t('aiDraft')}>
          <div className="ai-draft-head">
            <strong>{t('aiDraft')}</strong>
            <span className="muted">{t('aiReviewHint')}</span>
          </div>
          {started && (
            <div className={`ai-needed ${stillNeeded.length ? '' : 'done'}`} role="status">
              {stillNeeded.length ? (
                <>
                  <strong>{t('aiStillNeeded')}</strong> {stillNeeded.join(' · ')}
                </>
              ) : (
                <strong>{t('aiComplete')}</strong>
              )}
            </div>
          )}
          {assumptions.length > 0 && (
            <ul className="ai-assumptions">
              {assumptions.map((a, i) => (
                <li key={i}>
                  <Warning size={14} aria-hidden /> <span dir="auto">{a}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="form-grid">
            <Field label={t('name')} className="span-2">
              <input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={160} dir="auto" />
            </Field>
            <Field label={t('department')} warn={started && !draft.departmentId ? t('aiPickDepartment') : null}>
              <select className="select" value={draft.departmentId || ''} onChange={(e) => set('departmentId', Number(e.target.value))}>
                <option value="">-</option>
                {allowed.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deptName(d, lang)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('manager')} hint={planOnly ? t('ownerIsYou') : t('aiOwnerHint')}>
              <select className="select" value={planOnly ? meta.me.id : draft.ownerId || ''} disabled={planOnly} onChange={(e) => set('ownerId', Number(e.target.value))}>
                <option value="">{t('aiOwnerDefault')}</option>
                {meta.users
                  .filter((u) => u.active)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t('start')}>
              <DateInput className="input" value={draft.startDate} onChange={(e) => set('startDate', e.target.value)} />
            </Field>
            <Field label={t('finish')} warn={draft.startDate && draft.endDate && draft.endDate < draft.startDate ? t('aiEndBeforeStart') : null}>
              <DateInput className="input" value={draft.endDate} min={draft.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} />
            </Field>
            <Field label={t('priority')}>
              <select className="select" value={draft.priority} onChange={(e) => set('priority', e.target.value as ProjectDraft['priority'])}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`priority_${p}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('sponsor')}>
              <SponsorSelect value={draft.sponsor} onChange={(v) => set('sponsor', v)} />
            </Field>
            <Field label={t('objective')} className="span-2">
              <textarea className="input" rows={2} value={draft.objective} onChange={(e) => set('objective', e.target.value)} dir="auto" />
            </Field>
          </div>

          <div className="form-grid" style={{ marginTop: 14 }}>
            {PROJECT_PHASES.map((phase) => (
              <div key={phase} className="span-2" style={{ display: 'grid', gap: 10 }}>
                <strong style={{ fontSize: 13 }}>{phase}</strong>
                {STAGE_FIELDS[phase].map((f) => (
                  <Field key={f.key} label={`${lang === 'ar' ? f.ar : f.en} *`}>
                    {f.key === 'stakeholders' ? (
                      <PeoplePicker label={lang === 'ar' ? f.ar : f.en} value={draft[f.key]} onChange={(v) => set(f.key, v)} />
                    ) : f.number ? (
                      <input className="input num" inputMode="decimal" value={draft[f.key]} onChange={(e) => set(f.key, e.target.value)} />
                    ) : (
                      <textarea className="input" rows={2} dir="auto" value={draft[f.key]} onChange={(e) => set(f.key, e.target.value)} />
                    )}
                  </Field>
                ))}
              </div>
            ))}
          </div>

          <div className="ai-ms-head">
            <strong>{t('milestonesPage')}</strong>
            <span className="muted num">{draft.milestones.length}</span>
          </div>
          <div className="ai-ms">
            {draft.milestones.length === 0 && <div className="muted">{t('aiNoMilestones')}</div>}
            {draft.milestones.map((m, i) => (
              <div key={i} className="ai-ms-row">
                <input
                  className="input"
                  value={m.name}
                  aria-label={t('taskName')}
                  dir="auto"
                  maxLength={160}
                  onChange={(e) => set('milestones', draft.milestones.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <DateInput
                  className="input"
                  value={m.date}
                  aria-label={t('dueDate')}
                  min={draft.startDate || undefined}
                  max={draft.endDate || undefined}
                  onChange={(e) => set('milestones', draft.milestones.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
                />
                <select
                  className="select"
                  aria-label={t('phase')}
                  value={m.phase ?? ''}
                  onChange={(e) => set('milestones', draft.milestones.map((x, j) => (j === i ? { ...x, phase: e.target.value } : x)))}
                >
                  <option value="">{t('phaseChoose')}</option>
                  {PROJECT_PHASES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <button className="btn btn-ghost btn-icon btn-sm" aria-label={t('remove')} onClick={() => set('milestones', draft.milestones.filter((_, j) => j !== i))}>
                  <Trash size={15} />
                </button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={() => set('milestones', [...draft.milestones, { name: '', date: draft.endDate || draft.startDate }])}>
              <Plus size={14} weight="bold" aria-hidden /> {t('aiAddMilestone')}
            </button>
            {!milestonesOk && <div className="field-error">{t('aiMilestoneNeedsDate')}</div>}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
