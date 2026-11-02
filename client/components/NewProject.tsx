import { useState } from 'react';
import { Plus, Trash } from '@phosphor-icons/react';
import type { Priority, ProjectDetail } from '../../shared/types';
import { PRIORITIES } from '../../shared/types';
import { addDays } from '../../shared/dates';
import { api } from '../api';
import { useApp } from '../lib/app';
import { useT } from '../lib/i18n';
import { deptName } from '../lib/format';
import { Dialog, Field } from './ui';
import { PhasePicker } from './PhasePicker';
import { PROJECT_PHASES } from '../../shared/phases';

// The three steps mirror the PMO sequence a project must pass through:
// who owns it, why it exists (charter), and when it lands.
const STEPS = ['basics', 'charter', 'timeline'] as const;

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { meta, quarterId, canCreateIn } = useApp();
  const { t, lang } = useT();
  // Only the departments this person may start a project in; the owner defaults to that department's head.
  const allowed = meta.departments.filter((d) => canCreateIn(d.id));
  const ownerFor = (departmentId: number) => meta.departments.find((d) => d.id === departmentId)?.headUserId ?? meta.me.id;
  const quarter = meta.quarters.find((q) => q.id === quarterId);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    nameAr: '',
    departmentId: (allowed.find((d) => d.id === meta.me.departmentId) ?? allowed[0])?.id ?? 0,
    managerId: ownerFor((allowed.find((d) => d.id === meta.me.departmentId) ?? allowed[0])?.id ?? 0),
    sponsor: '',
    priority: 'medium' as Priority,
    quarterId: quarterId ?? null,
    objective: '',
    scope: '',
    description: '',
    budget: '',
    startDate: quarter && quarter.startsOn > meta.today ? quarter.startsOn : meta.today,
    endDate: quarter?.endsOn ?? addDays(meta.today, 60),
  });
  const [milestones, setMilestones] = useState<{ name: string; date: string }[]>([]);
  // Every phase starts ticked: the creator unticks the ones this project does not need.
  const [phases, setPhases] = useState<string[]>([...PROJECT_PHASES]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const stepValid = [
    form.name.trim().length > 0 && form.departmentId > 0,
    form.objective.trim().length > 0,
    form.startDate && form.endDate && form.endDate >= form.startDate,
  ];

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.post<ProjectDetail>('/api/projects', {
        ...form,
        phases,
        milestones: milestones.filter((m) => m.name.trim()),
      });
      onCreated(detail.project.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const labels = [t('basics'), t('charter'), t('timeline')];

  return (
    <Dialog
      title={t('newProject')}
      onClose={onClose}
      width={680}
      footer={
        <>
          {error && (
            <span className="field-error" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }} role="alert">
              {error}
            </span>
          )}
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              {t('back')}
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" disabled={!stepValid[step]} onClick={() => setStep(step + 1)}>
              {t('next')}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!stepValid[step] || busy} onClick={create}>
              {t('createProject')}
            </button>
          )}
        </>
      }
    >
      <ol className="stages" style={{ listStyle: 'none', padding: 0, margin: '0 0 22px', gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {labels.map((l, i) => (
          <li key={l} className="stage" data-state={i < step ? 'past' : i === step ? 'current' : 'future'}>
            <i />
            {i + 1}. {l}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="form-grid">
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
          <Field label={t('manager')} hint={t('ownerPickHint')}>
            <select className="select" value={form.managerId} onChange={(e) => set('managerId', Number(e.target.value))}>
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
            <input className="input" value={form.sponsor} onChange={(e) => set('sponsor', e.target.value)} />
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
        </div>
      )}

      {step === 1 && (
        <div className="form-grid">
          <Field label={t('objective')} className="span-2">
            <textarea className="textarea" value={form.objective} onChange={(e) => set('objective', e.target.value)} />
          </Field>
          <Field label={t('scope')} className="span-2">
            <textarea className="textarea" value={form.scope} onChange={(e) => set('scope', e.target.value)} />
          </Field>
          <Field label={t('description')} className="span-2">
            <textarea className="textarea" value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <Field label={t('budget')}>
            <input className="input num" inputMode="decimal" value={form.budget} onChange={(e) => set('budget', e.target.value)} />
          </Field>
        </div>
      )}

      {step === 2 && (
        <div className="form-grid">
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
            <input className="input" type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </Field>
          <Field label={t('finish')}>
            <input className="input" type="date" value={form.endDate} min={form.startDate} onChange={(e) => set('endDate', e.target.value)} />
          </Field>
          <PhasePicker value={phases} onChange={setPhases} />
          <div className="span-2 field">
            <span>{t('milestones')}</span>
            {milestones.map((m, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 160px 34px', gap: 8 }}>
                <input
                  className="input"
                  aria-label={t('name')}
                  value={m.name}
                  onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <input
                  className="input"
                  type="date"
                  aria-label={t('dueDate')}
                  value={m.date}
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
              onClick={() => setMilestones([...milestones, { name: '', date: form.endDate }])}
            >
              <Plus size={14} aria-hidden />
              {t('addMilestoneRow')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
