import { useState } from 'react';
import { Check, ClockCounterClockwise, Lock, Plus, Trash, X } from '@phosphor-icons/react';
import type { ChangeArea, ChangeRequest, ProjectDetail, ProposedChanges } from '../../shared/types';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { fmtDate, fmtDateTime, fmtNumber } from '../lib/format';
import { Dialog, Empty, Field } from './ui';

const AREAS: ChangeArea[] = ['scope', 'cost', 'schedule'];

/**
 * The project's change requests: the form to ask for a change, the two approvals (the head of the department, then
 * the PMO) and the change log. After the baseline, scope, cost and schedule change only this way.
 */
export function ChangesTab({ detail, canAsk, canKeep, onApplied }: { detail: ProjectDetail; canAsk: boolean; canKeep: boolean; onApplied: () => void }) {
  const { t, lang } = useT();
  const p = detail.project;
  const { data, error, reload } = useLoad(() => api.get<ChangeRequest[]>(`/api/projects/${p.id}/changes`), [p.id], 'changes');
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<ChangeRequest | null>(null);
  const baselined = Boolean(p.baselineEnd);

  return (
    <>
      <div className={`cr-banner ${baselined ? 'locked' : ''}`} role="note">
        <Lock size={16} weight={baselined ? 'fill' : 'regular'} aria-hidden />
        <span>{baselined ? t('cr_lockedBanner') : t('cr_openBanner')}</span>
        {canAsk && (
          <button className="btn btn-primary btn-sm" style={{ marginInlineStart: 'auto' }} onClick={() => setAsking(true)}>
            <Plus size={15} weight="bold" aria-hidden />
            {t('cr_new')}
          </button>
        )}
      </div>
      <div className="panel">
        {error ? (
          <div className="panel-body field-error">{error}</div>
        ) : !data ? (
          <div className="skeleton" style={{ height: 160, borderRadius: 12 }} />
        ) : data.length === 0 ? (
          <Empty title={t('cr_none')} body={t('cr_noneBody')} />
        ) : (
          <div className="table-wrap">
            <table className="table cr-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('cr_date')}</th>
                  <th>{t('cr_requestedBy')}</th>
                  <th>{t('cr_description')}</th>
                  <th>{t('cr_reason')}</th>
                  <th>{t('status')}</th>
                  <th>{t('cr_progress')}</th>
                  <th>{t('cr_actions')}</th>
                  <th>{t('cr_completion')}</th>
                  <th>{t('notes')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => setOpen(c)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(c)}>
                    <td className="code">{c.code}</td>
                    <td className="num">{fmtDate(c.requestedAt.slice(0, 10), lang, true)}</td>
                    <td>{c.requestedByName}</td>
                    <td className="cr-text" dir="auto">{c.description}</td>
                    <td className="cr-text" dir="auto">{c.reason}</td>
                    <td>
                      <StatusChip c={c} />
                    </td>
                    <td className="cr-text" dir="auto">{c.status === 'rejected' ? c.decisionNote : c.progress}</td>
                    <td className="cr-text" dir="auto">
                      {c.actions}
                      {c.areas.length > 0 && <div className="muted">{c.areas.map((a) => t(`cr_area_${a}` as TKey)).join(' · ')}</div>}
                    </td>
                    <td className="num">{c.completionDate ? fmtDate(c.completionDate, lang, true) : ''}</td>
                    <td className="cr-text" dir="auto">{c.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {asking && (
        <NewChangeDialog
          detail={detail}
          onClose={() => setAsking(false)}
          onCreated={(c) => {
            setAsking(false);
            reload();
            setOpen(c);
          }}
        />
      )}
      {open && (
        <ChangeDialog
          change={open}
          detail={detail}
          canKeep={canKeep}
          onClose={() => setOpen(null)}
          onChanged={(c) => {
            setOpen(c);
            reload();
            if (c.status === 'approved') onApplied();
          }}
          onDeleted={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
    </>
  );
}

export function StatusChip({ c }: { c: ChangeRequest }) {
  const { t } = useT();
  const tone = c.status === 'approved' ? '' : c.status === 'rejected' ? 'bad' : c.status === 'withdrawn' ? '' : 'warn';
  return (
    <span className={`flag-chip ${tone}`} title={c.status === 'pending' || c.status === 'on_hold' ? t(c.stage === 'head' ? 'cr_waitHead' : 'cr_waitPmo') : undefined}>
      {t(`cr_status_${c.status}` as TKey)}
      {(c.status === 'pending' || c.status === 'on_hold') && ` · ${t(c.stage === 'head' ? 'cr_stageHead' : 'cr_stagePmo')}`}
    </span>
  );
}

interface MilestoneRow {
  taskId: number | '';
  action: 'move' | 'cancel';
  to: string;
}

/** The change request form (the PMO's Change Request template), with the new values the change proposes. */
function NewChangeDialog({ detail, onClose, onCreated }: { detail: ProjectDetail; onClose: () => void; onCreated: (c: ChangeRequest) => void }) {
  const { t, lang } = useT();
  const { meta } = useApp();
  const p = detail.project;
  const milestones = detail.tasks.filter((x) => x.kind === 'milestone' && x.status !== 'cancelled');
  const phases = detail.tasks.filter((x) => x.kind === 'summary' && !x.notRequired);
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [actions, setActions] = useState('');
  const [actionsDate, setActionsDate] = useState('');
  const [areas, setAreas] = useState<ChangeArea[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [budget, setBudget] = useState('');
  const [scope, setScope] = useState('');
  const [objective, setObjective] = useState('');
  const [moves, setMoves] = useState<MilestoneRow[]>([]);
  const [added, setAdded] = useState<{ name: string; date: string; parentId: number | '' }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The button stays grey until the two required boxes have text (and any date typed is a real one): say which is missing.
  const bad = (d: string) => d !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < '2000-01-01' || d > '2100-12-31');
  const dates = [startDate, endDate, actionsDate, ...moves.map((m) => m.to), ...added.map((m) => m.date)];
  const missing = [description.trim().length < 3 && t('cr_description'), reason.trim().length < 3 && t('cr_reason'), dates.some(bad) && t('cr_badDate')].filter(Boolean) as string[];

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const changes: ProposedChanges & Record<string, unknown> = {};
    if (startDate) changes.startDate = startDate;
    if (endDate) changes.endDate = endDate;
    if (budget.trim()) changes.budget = Number(budget);
    if (scope.trim()) changes.scope = scope;
    if (objective.trim()) changes.objective = objective;
    const ms = moves.filter((m) => m.taskId && (m.action === 'cancel' || m.to));
    if (ms.length) changes.milestones = ms.map((m) => ({ taskId: Number(m.taskId), action: m.action, to: m.action === 'move' ? m.to : undefined }));
    const nm = added.filter((m) => m.name.trim() && m.date);
    if (nm.length) changes.newMilestones = nm.map((m) => ({ name: m.name.trim(), date: m.date, parentId: m.parentId ? Number(m.parentId) : null }));
    try {
      onCreated(await api.post<ChangeRequest>(`/api/projects/${p.id}/changes`, { description, reason, actions, actionsDate: actionsDate || null, areas, changes }));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('cr_formTitle')}
      onClose={onClose}
      width={820}
      footer={
        <>
          {err && (
            <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {err}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          {missing.length > 0 && !err && (
            <span className="field-error" role="status" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {t('cr_needed', { l: missing.join(' · ') })}
            </span>
          )}
          <button className="btn btn-primary" disabled={busy || missing.length > 0} onClick={submit}>
            {t('cr_submit')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('cr_requestedBy')}>
          <input className="input" value={meta.me.name} disabled readOnly />
        </Field>
        <Field label={t('cr_date')}>
          <input className="input" value={fmtDate(meta.today, lang, true)} disabled readOnly />
        </Field>
        <Field label={t('cr_description')} hint={t('cr_descriptionHint')} className="span-2">
          <textarea className="textarea" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t('cr_reason')} hint={t('cr_reasonHint')} className="span-2">
          <textarea className="textarea" dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="field span-2">
          <span>{t('cr_areas')}</span>
          <div className="phase-picker">
            {AREAS.map((a) => (
              <button key={a} type="button" className={`chip phase-chip ${areas.includes(a) ? 'on' : ''}`} aria-pressed={areas.includes(a)} onClick={() => setAreas(areas.includes(a) ? areas.filter((x) => x !== a) : [...areas, a])}>
                {t(`cr_area_${a}` as TKey)}
              </button>
            ))}
          </div>
          <span className="hint">{t('cr_areasHint')}</span>
        </div>
      </div>

      <h3 className="cr-section">{t('cr_proposed')}</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{t('cr_proposedHint')}</p>
      <div className="form-grid">
        <Field label={t('cr_newStart')} hint={t('cr_now', { v: fmtDate(p.startDate, lang, true) })}>
          <input className="input" type="date" min="2000-01-01" max="2100-12-31" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label={t('cr_newEnd')} hint={t('cr_now', { v: fmtDate(p.endDate, lang, true) })}>
          <input className="input" type="date" min="2000-01-01" max="2100-12-31" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
        <Field label={t('cr_newBudget')} hint={t('cr_now', { v: p.budget === null ? '-' : fmtNumber(p.budget, lang) })}>
          <input className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        <div />
        <Field label={t('cr_newScope')} className="span-2">
          <textarea className="textarea" dir="auto" placeholder={detail.project.scope ?? ''} value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
        <Field label={t('cr_newObjective')} className="span-2">
          <textarea className="textarea" dir="auto" placeholder={detail.project.objective ?? ''} value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <span>{t('cr_milestoneChanges')}</span>
        {moves.map((m, i) => (
          <div key={i} className="cr-row">
            <select className="select" aria-label={t('kind_milestone')} value={m.taskId} onChange={(e) => setMoves(moves.map((x, j) => (j === i ? { ...x, taskId: e.target.value ? Number(e.target.value) : '' } : x)))}>
              <option value="">{t('cr_pickMilestone')}</option>
              {milestones.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({fmtDate(x.endDate, lang)})
                </option>
              ))}
            </select>
            <select className="select" aria-label={t('cr_action')} value={m.action} onChange={(e) => setMoves(moves.map((x, j) => (j === i ? { ...x, action: e.target.value as 'move' | 'cancel' } : x)))}>
              <option value="move">{t('cr_action_move')}</option>
              <option value="cancel">{t('cr_action_cancel')}</option>
            </select>
            <input className="input" type="date" min="2000-01-01" max="2100-12-31" disabled={m.action !== 'move'} value={m.to} aria-label={t('cr_newDate')} onChange={(e) => setMoves(moves.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
            <button className="btn btn-ghost btn-icon btn-sm" aria-label={t('remove')} onClick={() => setMoves(moves.filter((_, j) => j !== i))}>
              <Trash size={15} />
            </button>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setMoves([...moves, { taskId: '', action: 'move', to: '' }])}>
          <Plus size={14} weight="bold" aria-hidden /> {t('cr_addMilestoneChange')}
        </button>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <span>{t('cr_newMilestones')}</span>
        {added.map((m, i) => (
          <div key={i} className="cr-row">
            <input className="input" dir="auto" placeholder={t('taskName')} value={m.name} onChange={(e) => setAdded(added.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <select className="select" aria-label={t('phase')} value={m.parentId} onChange={(e) => setAdded(added.map((x, j) => (j === i ? { ...x, parentId: e.target.value ? Number(e.target.value) : '' } : x)))}>
              <option value="">{t('cr_topOfPlan')}</option>
              {phases.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <input className="input" type="date" min="2000-01-01" max="2100-12-31" aria-label={t('dueDate')} value={m.date} onChange={(e) => setAdded(added.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
            <button className="btn btn-ghost btn-icon btn-sm" aria-label={t('remove')} onClick={() => setAdded(added.filter((_, j) => j !== i))}>
              <Trash size={15} />
            </button>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setAdded([...added, { name: '', date: '', parentId: '' }])}>
          <Plus size={14} weight="bold" aria-hidden /> {t('cr_addNewMilestone')}
        </button>
      </div>

      <h3 className="cr-section">{t('cr_actionsTitle')}</h3>
      <div className="form-grid">
        <Field label={t('cr_actions')} hint={t('cr_actionsHint')} className="span-2">
          <textarea className="textarea" dir="auto" value={actions} onChange={(e) => setActions(e.target.value)} />
        </Field>
        <Field label={t('cr_actionsDate')}>
          <input className="input" type="date" min="2000-01-01" max="2100-12-31" value={actionsDate} onChange={(e) => setActionsDate(e.target.value)} />
        </Field>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>{t('cr_approvalNote')}</p>
    </Dialog>
  );
}

/** One request: what it asks, what it would change, its approvals, and the change log's follow-up. */
function ChangeDialog({ change: c, detail, canKeep, onClose, onChanged, onDeleted }: { change: ChangeRequest; detail: ProjectDetail; canKeep: boolean; onClose: () => void; onChanged: (c: ChangeRequest) => void; onDeleted: () => void }) {
  const { t, lang } = useT();
  const { meta, can } = useApp();
  const toast = useToast();
  const head = meta.departments.find((d) => d.id === detail.project.departmentId)?.headUserId ?? null;
  const open = c.status === 'pending' || c.status === 'on_hold';
  const mine = c.requestedBy === meta.me.id;
  const mayDecide = open && !mine && (c.stage === 'head' ? head === meta.me.id : can('changes.approve'));
  // A request that was never approved (a test, a duplicate) can go; an approved one applied changes and stays.
  const mayDelete = can('changes.approve') && c.status !== 'approved';
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState(c.progress);
  const [notes, setNotes] = useState(c.notes);
  const [completion, setCompletion] = useState(c.completionDate ?? '');
  const [busy, setBusy] = useState(false);
  const name = (id: number) => detail.tasks.find((x) => x.id === id)?.name ?? c.before.milestones?.find((m) => m.taskId === id)?.name ?? `#${id}`;
  const d = (v: string | undefined | null) => (v ? fmtDate(v, lang, true) : '-');

  const act = async (fn: () => Promise<ChangeRequest>) => {
    setBusy(true);
    try {
      onChanged(await fn());
      setNote('');
      toast(t('saved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const decide = (decision: 'approve' | 'reject' | 'hold' | 'resume') => act(() => api.post<ChangeRequest>(`/api/changes/${c.id}/decide`, { decision, note }));
  const remove = async () => {
    if (!window.confirm(t('cr_deleteConfirm', { code: c.code }))) return;
    setBusy(true);
    try {
      await api.del(`/api/changes/${c.id}`);
      toast(t('saved'));
      onDeleted();
    } catch (e) {
      toast((e as Error).message, 'bad');
      setBusy(false);
    }
  };

  const rows: { what: string; now: string; next: string }[] = [];
  const ch = c.changes;
  if (ch.startDate) rows.push({ what: t('start'), now: d(c.before.startDate), next: d(ch.startDate) });
  if (ch.endDate) rows.push({ what: t('finish'), now: d(c.before.endDate), next: d(ch.endDate) });
  if (ch.budget !== undefined) rows.push({ what: t('budget'), now: c.before.budget == null ? '-' : fmtNumber(c.before.budget, lang), next: ch.budget == null ? '-' : fmtNumber(ch.budget, lang) });
  if (ch.scope !== undefined) rows.push({ what: t('scope'), now: c.before.scope || '-', next: ch.scope || '-' });
  if (ch.objective !== undefined) rows.push({ what: t('objective'), now: c.before.objective || '-', next: ch.objective || '-' });
  for (const m of ch.milestones ?? []) {
    const was = c.before.milestones?.find((x) => x.taskId === m.taskId);
    rows.push({ what: name(m.taskId), now: d(was?.date), next: m.action === 'cancel' ? t('cr_action_cancel') : d(m.to) });
  }
  for (const m of ch.newMilestones ?? []) rows.push({ what: `${t('cr_newMilestone')}: ${m.name}`, now: '-', next: d(m.date) });

  return (
    <Dialog
      title={
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="code">{c.code}</span> {t('cr_title')} <StatusChip c={c} />
        </span>
      }
      onClose={onClose}
      width={820}
      footer={
        <>
          {(mayDelete || (mine && open)) && (
            <span style={{ marginInlineEnd: 'auto', display: 'inline-flex', gap: 8 }}>
              {mayDelete && (
                <button className="btn btn-ghost btn-danger" disabled={busy} onClick={remove}>
                  <Trash size={15} aria-hidden /> {t('cr_delete')}
                </button>
              )}
              {mine && open && (
                <button className="btn btn-ghost btn-danger" disabled={busy} onClick={() => act(() => api.post<ChangeRequest>(`/api/changes/${c.id}/withdraw`))}>
                  {t('cr_withdraw')}
                </button>
              )}
            </span>
          )}
          {mayDecide && (
            <>
              {c.status === 'on_hold' ? (
                <button className="btn" disabled={busy} onClick={() => decide('resume')}>
                  {t('cr_resume')}
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => decide('hold')}>
                  <ClockCounterClockwise size={15} aria-hidden /> {t('cr_hold')}
                </button>
              )}
              <button className="btn" disabled={busy || note.trim().length < 3} title={t('cr_rejectNeedsReason')} onClick={() => decide('reject')}>
                <X size={15} aria-hidden /> {t('cr_reject')}
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => decide('approve')}>
                <Check size={15} weight="bold" aria-hidden /> {c.stage === 'head' ? t('cr_approveHead') : t('cr_approveFinal')}
              </button>
            </>
          )}
          {!mayDecide && !(mine && open) && (
            <button className="btn" onClick={onClose}>
              {t('close')}
            </button>
          )}
        </>
      }
    >
      <div className="cr-grid">
        <div>
          <div className="muted cr-label">{t('cr_requestedBy')}</div>
          <div>
            {c.requestedByName} · {fmtDateTime(c.requestedAt, lang)}
          </div>
        </div>
        <div>
          <div className="muted cr-label">{t('cr_areas')}</div>
          <div>{c.areas.map((a) => t(`cr_area_${a}` as TKey)).join(' · ')}</div>
        </div>
        <div className="span-2">
          <div className="muted cr-label">{t('cr_description')}</div>
          <div dir="auto" className="cr-pre">{c.description}</div>
        </div>
        <div className="span-2">
          <div className="muted cr-label">{t('cr_reason')}</div>
          <div dir="auto" className="cr-pre">{c.reason}</div>
        </div>
        {(c.actions || c.actionsDate) && (
          <div className="span-2">
            <div className="muted cr-label">{t('cr_actions')}</div>
            <div dir="auto" className="cr-pre">
              {c.actions} {c.actionsDate && <span className="muted">({d(c.actionsDate)})</span>}
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <h3 className="cr-section">{t('cr_proposed')}</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('cr_what')}</th>
                  <th>{t('cr_nowCol')}</th>
                  <th>{t('cr_nextCol')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td dir="auto">{r.what}</td>
                    <td className="muted" dir="auto">{r.now}</td>
                    <td dir="auto">
                      <strong>{r.next}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="cr-section">{t('cr_approvals')}</h3>
      <ol className="cr-steps">
        <li className="done">
          <strong>{t('cr_stepAsked')}</strong> {c.requestedByName} · {fmtDateTime(c.requestedAt, lang)}
        </li>
        <li className={c.headSkipped || c.headAt ? 'done' : c.stage === 'head' && c.status === 'rejected' ? 'bad' : ''}>
          <strong>{t('cr_stepHead')}</strong>{' '}
          {c.headSkipped
            ? t('cr_headSkipped', { why: c.headSkipped })
            : c.headAt
              ? `${c.headByName} · ${fmtDateTime(c.headAt, lang)}`
              : c.stage === 'head' && c.status === 'rejected'
                ? `${t('cr_status_rejected')}: ${c.decidedByName}`
                : t('cr_waiting')}
          {c.headNote && <div className="muted" dir="auto">{c.headNote}</div>}
        </li>
        <li className={c.status === 'approved' ? 'done' : c.stage === 'pmo' && c.status === 'rejected' ? 'bad' : ''}>
          <strong>{t('cr_stepPmo')}</strong>{' '}
          {c.status === 'approved' || (c.stage === 'pmo' && c.status === 'rejected')
            ? `${t(`cr_status_${c.status}` as TKey)}: ${c.decidedByName} · ${c.decidedAt ? fmtDateTime(c.decidedAt, lang) : ''}`
            : c.status === 'withdrawn'
              ? t('cr_status_withdrawn')
              : t('cr_waiting')}
          {c.decisionNote && <div className="muted" dir="auto">{c.decisionNote}</div>}
        </li>
      </ol>
      {c.applied && c.applied.length > 0 && (
        <div className="cr-applied">
          <strong>{t('cr_applied')}</strong>
          <ul>
            {c.applied.map((a, i) => (
              <li key={i} dir="auto">
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}

      {mayDecide && (
        <Field label={t('cr_decisionNote')} hint={t('cr_decisionNoteHint')}>
          <textarea className="textarea" dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}

      {canKeep && (
        <>
          <h3 className="cr-section">{t('cr_log')}</h3>
          <div className="form-grid">
            <Field label={t('cr_progress')} className="span-2">
              <textarea className="textarea" dir="auto" value={progress} onChange={(e) => setProgress(e.target.value)} />
            </Field>
            <Field label={t('cr_completion')}>
              <input className="input" type="date" min="2000-01-01" max="2100-12-31" value={completion} onChange={(e) => setCompletion(e.target.value)} />
            </Field>
            <div />
            <Field label={t('notes')} className="span-2">
              <textarea className="textarea" dir="auto" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <button
            className="btn btn-sm"
            disabled={busy || (progress === c.progress && notes === c.notes && completion === (c.completionDate ?? ''))}
            onClick={() => act(() => api.patch<ChangeRequest>(`/api/changes/${c.id}`, { progress, notes, completionDate: completion || null }))}
          >
            {t('save')}
          </button>
        </>
      )}
    </Dialog>
  );
}
