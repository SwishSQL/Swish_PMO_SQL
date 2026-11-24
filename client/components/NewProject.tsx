import { useState } from 'react';
import { Plus, Trash } from '@phosphor-icons/react';
import type { Initiative, Priority, ProjectDetail } from '../../shared/types';
import { PRIORITIES } from '../../shared/types';
import { addDays } from '../../shared/dates';
import { PROJECT_PHASES } from '../../shared/phases';
import type { ProjectPhase } from '../../shared/phases';
import { STAGE_FIELDS, missingForCreation } from '../../shared/stageRequirements';
import type { StageFieldKey } from '../../shared/stageRequirements';
import { api } from '../api';
import { useApp, useLoad } from '../lib/app';
import { useT } from '../lib/i18n';
import { deptName } from '../lib/format';
import { Dialog, Field } from './ui';
import { DateInput } from './DateInput';
import { SponsorSelect } from './SponsorSelect';
import { PeoplePicker } from './PeoplePicker';
import { LearnMore } from './Tour';

// A project is created in six slides: who and when, then one slide per lifecycle stage with what that stage must
// state and its milestones. A slide opens the next only when it is complete; the server checks the same rules.

type Milestone = { name: string; date: string; phase: ProjectPhase };
const STAGE_KEY: Record<ProjectPhase, string> = {
  Initiation: 'initiation',
  Planning: 'planning',
  Execution: 'execution',
  'Monitoring & Control': 'monitoring',
  Closure: 'closure',
};

/** What a project started from a plan project begins with: its name, its link, and what the workbook says. */
export interface ProjectPreset {
  initiativeId: number;
  name: string;
  description?: string | null;
  objective?: string | null;
  successMetric?: string | null;
  successTarget?: string | null;
  acceptanceCriteria?: string | null;
  /** Everything known about it, for the assistant to start from. */
  context?: string;
}

export function presetFrom(it: { id: number; name: string; outcome: string | null; outcomeKpi: string | null; target: string | null; completionCriteria: string | null; owner: string | null; baseline: string | null; startDate: string | null; targetCompletion: string | null; priority: string | null; type: string | null }): ProjectPreset {
  const lines = [
    ['Plan project', it.name],
    ['Type', it.type],
    ['Owner', it.owner],
    ['Priority', it.priority],
    ['Expected outcome', it.outcome],
    ['Completion criteria', it.completionCriteria],
    ['Outcome KPI', it.outcomeKpi],
    ['Baseline', it.baseline],
    ['Target', it.target],
    ['Start', it.startDate],
    ['Target completion', it.targetCompletion],
  ].filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`);
  return {
    initiativeId: it.id,
    name: it.name,
    description: it.outcome,
    objective: it.outcome,
    successMetric: it.outcomeKpi,
    successTarget: it.target,
    acceptanceCriteria: it.completionCriteria,
    context: lines.join('\n'),
  };
}

export function NewProjectDialog({ onClose, onCreated, preset }: { onClose: () => void; onCreated: (id: number) => void; preset?: ProjectPreset }) {
  const { meta, quarterId, canCreateIn, can } = useApp();
  const { t, lang } = useT();
  // A project manager (no department to start projects in) starts one from a plan project nobody has started yet,
  // in any department, and runs it.
  const planOnly = !meta.departments.some((d) => canCreateIn(d.id)) && can('projects.start_plan');
  const open = useLoad(() => (planOnly && !preset ? api.get<(Initiative & { portfolio: string; program: string })[]>('/api/transformation/open') : Promise.resolve([])), [planOnly, !!preset]);
  const [picked, setPicked] = useState<ProjectPreset | undefined>(preset);
  // Only the departments this person may start a project in; the owner defaults to that department's head.
  const allowed = planOnly ? meta.departments : meta.departments.filter((d) => canCreateIn(d.id));
  const ownerFor = (departmentId: number) => (planOnly ? meta.me.id : meta.departments.find((d) => d.id === departmentId)?.headUserId ?? meta.me.id);
  const quarter = meta.quarters.find((q) => q.id === quarterId);
  const firstDept = (allowed.find((d) => d.id === meta.me.departmentId) ?? allowed[0])?.id ?? 0;
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: preset?.name ?? '',
    nameAr: '',
    departmentId: firstDept,
    managerId: ownerFor(firstDept),
    sponsor: '',
    priority: 'medium' as Priority,
    quarterId: quarterId ?? null,
    description: preset?.description ?? '',
    startDate: quarter && quarter.startsOn > meta.today ? quarter.startsOn : meta.today,
    endDate: quarter?.endsOn ?? addDays(meta.today, 60),
  });
  const [stage, setStage] = useState<Record<StageFieldKey, string>>(
    Object.fromEntries(Object.values(STAGE_FIELDS).flatMap((fs) => fs.map((f) => [f.key, (preset as Record<string, unknown> | undefined)?.[f.key] ?? '']))) as Record<StageFieldKey, string>,
  );
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const choosePlan = (id: number) => {
    const it = (open.data ?? []).find((x) => x.id === id);
    const p = it ? presetFrom(it) : undefined;
    setPicked(p);
    if (!p) return;
    setForm((f) => ({ ...f, name: p.name, description: p.description ?? f.description }));
    setStage((s) => ({ ...s, ...Object.fromEntries(Object.keys(s).filter((k) => (p as unknown as Record<string, unknown>)[k]).map((k) => [k, (p as unknown as Record<string, string>)[k]])) }));
  };
  const body = { ...form, ...stage, phases: [...PROJECT_PHASES], milestones: milestones.filter((m) => m.name.trim()), ...(picked ? { initiativeId: picked.initiativeId } : {}) };
  const missing = missingForCreation(body, lang === 'ar' ? 'ar' : 'en');
  const basicsOk = (!planOnly || !!picked) && form.name.trim().length > 0 && form.departmentId > 0 && !!form.sponsor.trim() && !!form.startDate && !!form.endDate && form.endDate >= form.startDate;
  const phaseOf = (i: number) => PROJECT_PHASES[i - 1];
  const slideMissing = (i: number) => (i === 0 ? (basicsOk ? [] : [t('stageBasicsMissing')]) : (missing.find((m) => m.phase === phaseOf(i))?.items ?? []));
  const labels = [t('basics'), ...PROJECT_PHASES.map((p) => t(`stage_${STAGE_KEY[p]}` as never))];
  const last = labels.length - 1;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.post<ProjectDetail>('/api/projects', body);
      onCreated(detail.project.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const here = slideMissing(step);
  return (
    <Dialog
      title={t('newProject')}
      onClose={onClose}
      width={760}
      footer={
        <>
          <LearnMore page="newproject" />
          {(error || (here.length > 0 && step > 0)) && (
            <span className="field-error" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }} role="alert">
              {error ?? `${t('stillNeeded')}: ${here.join(', ')}`}
            </span>
          )}
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              {t('back')}
            </button>
          )}
          {step < last ? (
            <button className="btn btn-primary" disabled={here.length > 0} onClick={() => setStep(step + 1)}>
              {t('next')}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={missing.length > 0 || !basicsOk || busy} onClick={create}>
              {t('createProject')}
            </button>
          )}
        </>
      }
    >
      <ol className="stages" style={{ listStyle: 'none', padding: 0, margin: '0 0 22px', gridTemplateColumns: `repeat(${labels.length}, 1fr)` }}>
        {labels.map((l, i) => (
          <li key={l} className="stage" data-state={i < step ? 'past' : i === step ? 'current' : 'future'}>
            <i />
            {i + 1}. {l}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="form-grid">
          {planOnly && !preset && (
            <Field label={`${t('planPick')} *`} hint={open.data && !open.data.length ? t('planPickEmpty') : t('planPickHint')} className="span-2">
              <select className="select" value={picked?.initiativeId ?? ''} onChange={(e) => choosePlan(Number(e.target.value))}>
                <option value="">{t('planPickNone')}</option>
                {(open.data ?? []).map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} · {it.program}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('name')} className="span-2">
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={160} />
          </Field>
          <Field label={t('nameAr')} className="span-2">
            <input className="input" dir="rtl" value={form.nameAr} onChange={(e) => set('nameAr', e.target.value)} maxLength={160} />
          </Field>
          <Field label={t('department')}>
            <select
              className="select"
              value={form.departmentId}
              onChange={(e) => setForm((f) => ({ ...f, departmentId: Number(e.target.value), managerId: ownerFor(Number(e.target.value)) }))}
            >
              {allowed.map((d) => (
                <option key={d.id} value={d.id}>
                  {deptName(d, lang)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('manager')} hint={planOnly ? t('ownerIsYou') : t('ownerPickHint')}>
            <select className="select" value={form.managerId} disabled={planOnly} onChange={(e) => set('managerId', Number(e.target.value))}>
              {meta.users
                .filter((u) => u.active)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('sponsor')}>
            <SponsorSelect value={form.sponsor} onChange={(v) => set('sponsor', v)} />
          </Field>
          <Field label={t('priority')}>
            <select className="select" value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority_${p}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('quarter')}>
            <select className="select" value={form.quarterId ?? ''} onChange={(e) => set('quarterId', e.target.value ? Number(e.target.value) : null)}>
              {meta.quarters.map((q) => (
                <option key={q.id} value={q.id}>
                  Q{q.q} {q.year}
                </option>
              ))}
            </select>
          </Field>
          <div />
          <Field label={t('start')}>
            <DateInput value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </Field>
          <Field label={t('finish')}>
            <DateInput value={form.endDate} min={form.startDate} onChange={(e) => set('endDate', e.target.value)} />
          </Field>
          <Field label={t('description')} className="span-2">
            <textarea className="textarea" value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </div>
      )}

      {step > 0 &&
        (() => {
          const phase = phaseOf(step);
          const mine = milestones.map((m, i) => ({ m, i })).filter(({ m }) => m.phase === phase);
          return (
            <div className="form-grid">
              <p className="muted span-2" style={{ margin: 0, fontSize: 13 }}>
                {t(`stageHint_${STAGE_KEY[phase]}` as never)}
              </p>
              {STAGE_FIELDS[phase].map((f) => (
                <Field key={f.key} label={`${lang === 'ar' ? f.ar : f.en} *`} hint={lang === 'ar' ? f.hintAr : f.hintEn} className={f.number ? undefined : 'span-2'}>
                  {f.key === 'stakeholders' ? (
                    <PeoplePicker label={lang === 'ar' ? f.ar : f.en} value={stage[f.key]} onChange={(v) => setStage({ ...stage, [f.key]: v })} />
                  ) : f.number ? (
                    <input className="input num" inputMode="decimal" value={stage[f.key]} onChange={(e) => setStage({ ...stage, [f.key]: e.target.value })} />
                  ) : (
                    <textarea className="textarea" dir="auto" value={stage[f.key]} onChange={(e) => setStage({ ...stage, [f.key]: e.target.value })} />
                  )}
                </Field>
              ))}
              <div className="span-2 field">
                <span>
                  {t('stageMilestones')} *
                </span>
                {mine.map(({ m, i }) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 170px 34px', gap: 8 }}>
                    <input
                      className="input"
                      aria-label={t('name')}
                      value={m.name}
                      onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <DateInput
                      aria-label={t('dueDate')}
                      value={m.date}
                      min={form.startDate}
                      max={form.endDate}
                      onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
                    />
                    <button className="btn btn-ghost btn-icon" aria-label={t('remove')} onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}>
                      <Trash size={16} />
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-sm"
                  style={{ justifySelf: 'start' }}
                  onClick={() => setMilestones([...milestones, { name: '', date: mine[mine.length - 1]?.m.date ?? form.startDate, phase }])}
                >
                  <Plus size={14} aria-hidden />
                  {t('addMilestoneRow')}
                </button>
              </div>
            </div>
          );
        })()}
    </Dialog>
  );
}
