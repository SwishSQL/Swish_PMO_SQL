import { useEffect, useState } from 'react';
import { ArrowRight, CalendarX, Check, PaperPlaneRight, Siren, Trash, X } from '@phosphor-icons/react';
import type { DeadlineChange, Dependency, Escalation, MilestoneUpdate, Task, TaskStatus, User } from '../../shared/types';
import { spanDays } from '../../shared/dates';
import { api } from '../api';
import { useApp, useToast } from '../lib/app';
import { dayOffLabel, useCalendar } from '../lib/calendar';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { fmtDate, fmtDateTime } from '../lib/format';
import { stagger } from '../lib/motion';
import { Drawer, Field } from './ui';

interface Props {
  task: Task;
  tasks: Task[];
  dependencies: Dependency[];
  users: User[];
  /** The project's department: whoever is not the PMO can give work only to people of it. */
  departmentId: number;
  /** The project has an approved baseline: a milestone's date and type change only through a change request. */
  baselined?: boolean;
  canEdit: boolean;
  isCritical: boolean;
  floatDays: number | undefined;
  onClose: () => void;
  /** Resolves once the server has the change, so the panel can reload what depends on it. */
  onPatch: (patch: Partial<Task>) => Promise<unknown> | void;
  onAddDependency: (predecessorId: number, lagDays: number) => void;
  onRemoveDependency: (id: number) => void;
  onDelete: () => void;
  /** Phases and milestones: only the project manager or the PMO may remove them or turn them into tasks. */
  canGovern: boolean;
  /** Reload the project after something that can change its dates (a rejected move). */
  onReload: () => void;
}

export function TaskPanel(p: Props) {
  const { t } = useT();
  const { task } = p;
  const [name, setName] = useState(task.name);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [progress, setProgress] = useState(task.progress);
  const [newPred, setNewPred] = useState<number | ''>('');
  const [lag, setLag] = useState(0);
  const [ownerName, setOwnerName] = useState(task.ownerName ?? '');
  const [coOwners, setCoOwners] = useState(task.coOwners ?? '');
  const [dept, setDept] = useState(task.responsibleDept ?? '');
  const [escalate, setEscalate] = useState(task.escalateTo ?? '');
  const [blocker, setBlocker] = useState(task.blocker ?? '');
  // The update being written: status and % start from the task, the comment starts empty.
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [log, setLog] = useState<MilestoneUpdate[] | null>(null);
  const { lang } = useT();
  const { meta, can } = useApp();
  const cal = useCalendar();
  const toast = useToast();
  const [changes, setChanges] = useState<DeadlineChange[]>([]);
  const [escs, setEscs] = useState<Escalation[]>([]);
  const [escTo, setEscTo] = useState('');
  const [escNote, setEscNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(task.name);
    setNotes(task.notes ?? '');
    setProgress(task.progress);
    setStatus(task.status);
    setOwnerName(task.ownerName ?? '');
    setCoOwners(task.coOwners ?? '');
    setDept(task.responsibleDept ?? '');
    setEscalate(task.escalateTo ?? '');
    setBlocker(task.blocker ?? '');
  }, [task.id, task.name, task.notes, task.progress, task.status, task.ownerName, task.coOwners, task.responsibleDept, task.escalateTo, task.blocker]);

  // Every update posted on this item, newest first.
  const loadLog = async (id: number) => {
    try {
      return await api.get<MilestoneUpdate[]>(`/api/tasks/${id}/updates`);
    } catch {
      return [];
    }
  };
  useEffect(() => {
    let live = true;
    setLog(null);
    setComment('');
    if (task.kind === 'summary') setLog([]);
    else loadLog(task.id).then((rows) => live && setLog(rows));
    return () => {
      live = false;
    };
  }, [task.id, task.kind]);

  // Date changes (milestones) and escalations for this item.
  const fetchFollow = (id: number) =>
    Promise.all([
      api.get<DeadlineChange[]>(`/api/tasks/${id}/changes`).catch(() => [] as DeadlineChange[]),
      api.get<Escalation[]>(`/api/tasks/${id}/escalations`).catch(() => [] as Escalation[]),
    ]);
  const loadFollow = async (id: number) => {
    const [c, e] = await fetchFollow(id);
    setChanges(c);
    setEscs(e);
  };
  useEffect(() => {
    let live = true;
    setChanges([]);
    setEscs([]);
    setEscNote('');
    setEscTo(task.escalateTo ?? '');
    if (task.kind !== 'summary') {
      fetchFollow(task.id).then(([c, e]) => {
        if (!live) return;
        setChanges(c);
        setEscs(e);
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.kind, task.endDate]);
  const who = (id: number | null) => (id ? p.users.find((x) => x.id === id)?.name : null) ?? '-';
  const guarded = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const decide = (c: DeadlineChange, decision: 'approve' | 'reject') =>
    guarded(async () => {
      await api.post(`/api/deadline-changes/${c.id}/decide`, { decision });
      await loadFollow(task.id);
      if (decision === 'reject') p.onReload();
    });
  const raiseEscalation = () =>
    guarded(async () => {
      await api.post(`/api/tasks/${task.id}/escalations`, { toName: escTo.trim(), note: escNote.trim() || null });
      setEscNote('');
      await loadFollow(task.id);
      toast(t('escalated'));
    });
  const resolveEsc = (e: Escalation) =>
    guarded(async () => {
      await api.post(`/api/escalations/${e.id}/resolve`);
      await loadFollow(task.id);
    });

  // The Post button sends everything at once, so the server writes one history row.
  const dirty = status !== task.status || progress !== task.progress || blocker.trim() !== (task.blocker ?? '') || comment.trim() !== '';
  const post = async () => {
    setPosting(true);
    try {
      await p.onPatch({
        status,
        progress,
        blocker: blocker.trim() || null,
        ...(comment.trim() ? { updateComment: comment.trim() } : {}),
      } as Partial<Task>);
      setComment('');
      setLog(await loadLog(task.id));
    } finally {
      setPosting(false);
    }
  };
  const authorOf = (u: MilestoneUpdate) => (u.authorId ? p.users.find((x) => x.id === u.authorId)?.name : null) ?? t('fromTrackerImport');

  // Save a text field when focus leaves it, and only if it changed.
  const saveText = (key: keyof Task, value: string, current: string | null) =>
    value.trim() !== (current ?? '') && p.onPatch({ [key]: value.trim() || null } as Partial<Task>);

  const preds = p.dependencies.filter((d) => d.successorId === task.id);
  const byId = new Map(p.tasks.map((x) => [x.id, x]));
  const candidates = p.tasks.filter(
    (x) => x.id !== task.id && x.kind !== 'summary' && !preds.some((d) => d.predecessorId === x.id),
  );
  const ro = !p.canEdit;
  const isSummary = task.kind === 'summary';

  return (
    <Drawer onClose={p.onClose} label={task.name}>
      <div className="dialog-head" style={{ paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
        <div>
          <div className="code">
            {t(`kind_${task.kind}`)}
            {task.code ? ` / ${task.code}` : ''}
          </div>
          <h2 className="dialog-title" style={{ marginTop: 2 }}>
            {task.name}
          </h2>
        </div>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={p.onClose} aria-label={t('close')}>
          <X size={16} />
        </button>
      </div>
      <div className="dialog-body" style={{ display: 'grid', gap: 18, flex: 1 }}>
        {!isSummary && p.dependencies.length > 0 && (
          <div
            className="pill"
            style={{
              justifySelf: 'start',
              height: 'auto',
              padding: '6px 10px',
              whiteSpace: 'normal',
              background: p.isCritical ? 'var(--bad-soft)' : 'var(--surface-2)',
              color: p.isCritical ? 'var(--bad)' : 'var(--ink-2)',
            }}
          >
            {p.isCritical ? t('onCriticalPath') : t('floatDays', { n: Math.max(0, p.floatDays ?? 0) })}
          </div>
        )}

        <Field label={t('taskName')}>
          <input
            className="input"
            value={name}
            disabled={ro}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== task.name && p.onPatch({ name: name.trim() })}
          />
        </Field>

        {isSummary && (
          <label className="field" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={task.notRequired} disabled={ro || !p.canGovern} onChange={(e) => p.onPatch({ notRequired: e.target.checked })} style={{ marginTop: 3 }} />
            <span>
              {t('notRequired')}
              <span className="hint" style={{ display: 'block' }}>{t('notRequiredHint')}</span>
            </span>
          </label>
        )}

        {!isSummary && (
          <div className="form-grid">
            <Field
              label={task.kind === 'milestone' ? t('dueDate') : t('start')}
              warn={dayOffLabel(cal, task.startDate, t, lang)}
              hint={task.kind === 'milestone' && p.baselined ? t('cr_milestoneLocked') : undefined}
            >
              <input
                className="input"
                type="date"
                value={task.startDate}
                disabled={ro || (task.kind === 'milestone' && p.baselined)}
                onChange={(e) => {
                  if (!e.target.value) return;
                  // Moving the start keeps the duration, as dragging the bar does.
                  const len = spanDays(task.startDate, task.endDate) - 1;
                  const end = new Date(Date.parse(e.target.value) + len * 86_400_000).toISOString().slice(0, 10);
                  p.onPatch(task.kind === 'milestone' ? { startDate: e.target.value } : { startDate: e.target.value, endDate: end });
                }}
              />
            </Field>
            {task.kind === 'task' ? (
              <Field
                label={t('finish')}
                warn={dayOffLabel(cal, task.endDate, t, lang)}
                hint={t('workDaysCount', { n: cal.workdays(task.startDate, task.endDate) })}
              >
                <input
                  className="input"
                  type="date"
                  value={task.endDate}
                  min={task.startDate}
                  disabled={ro}
                  onChange={(e) => e.target.value && p.onPatch({ endDate: e.target.value })}
                />
              </Field>
            ) : null}
          </div>
        )}

        {!isSummary && (
          <div className="form-grid">
            {/* Always there, so a task can be turned back into a milestone and the other way round. */}
            <Field label={t('kindLabel')}>
              <select
                className="select"
                disabled={ro || (task.kind === 'milestone' && (!p.canGovern || p.baselined))}
                value={task.kind}
                onChange={(e) => p.onPatch({ kind: e.target.value as Task['kind'] })}
              >
                <option value="milestone">{t('kind_milestone')}</option>
                <option value="task">{t('kind_task')}</option>
              </select>
            </Field>
            <Field label={t('owner')}>
              <select
                className="select"
                value={task.assigneeId ?? ''}
                disabled={ro}
                onChange={(e) => p.onPatch({ assigneeId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">{t('unassigned')}</option>
                {p.users
                  .filter((u) => u.active && (can('projects.edit_all') || u.departmentId === p.departmentId || u.id === task.assigneeId))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        )}

        {!isSummary && (
          <div className="form-grid">
            <Field label={t('responsibleOwner')} hint={task.assigneeId ? t('linkedToUser') : t('fromTracker')} className="span-2">
              <input
                className="input"
                value={ownerName}
                disabled={ro}
                onChange={(e) => setOwnerName(e.target.value)}
                onBlur={() => saveText('ownerName', ownerName, task.ownerName)}
              />
            </Field>
            <Field label={t('coOwners')}>
              <input className="input" value={coOwners} disabled={ro} onChange={(e) => setCoOwners(e.target.value)} onBlur={() => saveText('coOwners', coOwners, task.coOwners)} />
            </Field>
            <Field label={t('responsibleDept')}>
              <input className="input" value={dept} disabled={ro} onChange={(e) => setDept(e.target.value)} onBlur={() => saveText('responsibleDept', dept, task.responsibleDept)} />
            </Field>
            <Field label={t('escalateTo')}>
              <input className="input" value={escalate} disabled={ro} onChange={(e) => setEscalate(e.target.value)} onBlur={() => saveText('escalateTo', escalate, task.escalateTo)} />
            </Field>
            {task.dependencyType && (
              <Field label={t('dependency')}>
                <input className="input" value={task.dependencyType.replace('_', ' ')} disabled readOnly />
              </Field>
            )}
          </div>
        )}

        {/* One form, one history row: status, %, what happened and the blocker go together. */}
        {!isSummary && (
          <section className="update-card" aria-label={t('postUpdate')}>
            <div className="update-card-head">
              <strong>{t('postUpdate')}</strong>
              <span className="muted">
                {task.lastUpdateOn ? t('updatedOn', { d: fmtDate(task.lastUpdateOn, lang, true) }) : t('neverUpdated')}
              </span>
            </div>
            <div className="form-grid">
              <Field label={t('status')}>
                <select
                  className="select"
                  value={status}
                  disabled={ro}
                  onChange={(e) => {
                    const s = e.target.value as TaskStatus;
                    setStatus(s);
                    if (s === 'done') setProgress(100);
                  }}
                >
                  {(['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as TaskStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {t(`status_${s}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`${t('progress')} ${progress}%`}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={progress}
                  disabled={ro}
                  onChange={(e) => setProgress(Number(e.target.value))}
                  style={{ accentColor: 'var(--ink)', marginTop: 10 }}
                />
              </Field>
              <Field label={t('whatHappened')} hint={t('whatHappenedHint')} className="span-2">
                <textarea className="textarea" style={{ minHeight: 64 }} value={comment} disabled={ro} onChange={(e) => setComment(e.target.value)} />
              </Field>
              <Field label={t('blockerLabel')} hint={t('blockerHint')} className="span-2">
                <textarea className="textarea" style={{ minHeight: 48 }} value={blocker} disabled={ro} onChange={(e) => setBlocker(e.target.value)} />
              </Field>
            </div>
            {!ro && (
              <button className="btn btn-primary" style={{ justifySelf: 'start' }} disabled={posting || !dirty} onClick={post}>
                <PaperPlaneRight size={15} weight="bold" aria-hidden />
                {t('postUpdateBtn')}
              </button>
            )}
          </section>
        )}

        {task.kind === 'milestone' && changes.length > 0 && (
          <div className="field">
            <span>
              <CalendarX size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> {t('deadlineChanges')} ({changes.length})
            </span>
            <ol className="update-log">
              {changes.map((c) => (
                <li key={c.id}>
                  <div className="update-log-meta">
                    <strong className="date-move num">
                      {fmtDate(c.fromDate, lang, true)} <ArrowRight size={12} aria-hidden style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} /> {fmtDate(c.toDate, lang, true)}
                    </strong>
                    <span className={`flag-chip ${c.status === 'pending' ? 'warn' : c.status === 'rejected' ? 'bad' : ''}`}>{t(`change_${c.status}` as TKey)}</span>
                  </div>
                  <p>{c.reason}</p>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {c.automatic ? t('changeAutomatic') : who(c.requestedBy)} · {fmtDateTime(c.requestedAt, lang)}
                    {c.decidedBy && c.status !== 'pending' && !c.automatic ? ` · ${t('decidedBy', { name: who(c.decidedBy) })}` : ''}
                  </div>
                  {c.status === 'pending' && p.canGovern && c.requestedBy !== meta.me.id && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide(c, 'approve')}>
                        <Check size={14} weight="bold" aria-hidden />
                        {t('approve')}
                      </button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => decide(c, 'reject')}>
                        {t('rejectChange')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {!isSummary && (
          <div className="field">
            <span>
              <Siren size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> {t('escalations')}
              {escs.length > 0 ? ` (${escs.length})` : ''}
            </span>
            {escs.length === 0 && (
              <div className="muted" style={{ fontSize: 13 }}>
                {t('noEscalations')}
              </div>
            )}
            {escs.length > 0 && (
              <ol className="update-log">
                {escs.map((e) => (
                  <li key={e.id}>
                    <div className="update-log-meta">
                      <strong>
                        {t('escLevel', { n: e.level })} · {e.toName}
                      </strong>
                      <span className={`flag-chip ${e.resolvedAt ? '' : 'warn'}`}>{e.resolvedAt ? t('escClosed') : t('escOpen')}</span>
                    </div>
                    {e.note && <p>{e.note}</p>}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {who(e.raisedBy)} · {fmtDateTime(e.raisedAt, lang)}
                      {e.resolvedAt ? ` · ${t('escClosedOn', { d: fmtDateTime(e.resolvedAt, lang) })}` : ''}
                    </div>
                    {!e.resolvedAt && !ro && (
                      <button className="btn btn-sm" style={{ justifySelf: 'start', marginTop: 4 }} disabled={busy} onClick={() => resolveEsc(e)}>
                        {t('escClose')}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {!ro && (
              <div className="update-card" style={{ marginTop: 8 }}>
                <Field label={t('escTo')} hint={t('escToHint')}>
                  <input className="input" value={escTo} onChange={(e) => setEscTo(e.target.value)} />
                </Field>
                <Field label={t('escNote')}>
                  <textarea className="textarea" style={{ minHeight: 48 }} value={escNote} onChange={(e) => setEscNote(e.target.value)} />
                </Field>
                <button className="btn" style={{ justifySelf: 'start' }} disabled={busy || !escTo.trim()} onClick={raiseEscalation}>
                  <Siren size={15} aria-hidden />
                  {t('escRaise', { n: Math.max(0, ...escs.filter((e) => !e.resolvedAt).map((e) => e.level)) + 1 })}
                </button>
              </div>
            )}
          </div>
        )}

        {!isSummary && (
          <div className="field">
            <span>
              {t('updateLog')}
              {log && log.length > 0 ? ` (${log.length})` : ''}
            </span>
            {log === null ? (
              <div className="skeleton" style={{ height: 52, borderRadius: 10 }} />
            ) : log.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>
                {t('noUpdatesYet')}
              </div>
            ) : (
              <ol className="update-log">
                {log.map((u, i) => (
                  <li key={u.id} className="enter" style={stagger(Math.min(i, 12))}>
                    <div className="update-log-meta">
                      <strong>{authorOf(u)}</strong>
                      {/* The import only knew the day, so its rows show no clock time. */}
                      <span className="num">{u.authorId ? fmtDateTime(u.createdAt, lang) : fmtDate(u.createdAt.slice(0, 10), lang, true)}</span>
                    </div>
                    <div className="update-log-state">
                      <span className="tag">{t(`status_${u.status}`)}</span>
                      <span className="num">{u.progress}%</span>
                    </div>
                    {u.comment && <p>{u.comment}</p>}
                    {u.blocker && (
                      <p className="update-log-blocker">
                        {t('blockerLabel')}: {u.blocker}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {!isSummary && (
          <div className="field">
            <span>{t('predecessors')}</span>
            {preds.length === 0 && <div className="muted" style={{ fontSize: 13 }}>-</div>}
            {preds.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {byId.get(d.predecessorId)?.name}
                </span>
                {d.lagDays !== 0 && <span className="code">+{d.lagDays}d</span>}
                {!ro && (
                  <button className="btn btn-ghost btn-sm btn-icon" aria-label={t('remove')} onClick={() => p.onRemoveDependency(d.id)}>
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            {!ro && candidates.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 72px auto', gap: 6 }}>
                <select className="select" aria-label={t('addPredecessor')} value={newPred} onChange={(e) => setNewPred(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">{t('addPredecessor')}</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input className="input num" type="number" aria-label={t('lag')} title={t('lag')} value={lag} onChange={(e) => setLag(Number(e.target.value))} />
                <button
                  className="btn"
                  disabled={!newPred}
                  onClick={() => {
                    if (newPred) p.onAddDependency(newPred, lag);
                    setNewPred('');
                    setLag(0);
                  }}
                >
                  {t('add')}
                </button>
              </div>
            )}
          </div>
        )}

        <Field label={t('notes')}>
          <textarea
            className="textarea"
            value={notes}
            disabled={ro}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (task.notes ?? '') && p.onPatch({ notes })}
          />
        </Field>
      </div>
      {!ro && (
        <div className="dialog-foot" style={{ justifyContent: 'space-between' }}>
          {p.canGovern || (task.kind === 'task' && !p.tasks.some((c) => c.parentId === task.id)) ? (
            <button className="btn btn-ghost btn-danger" onClick={p.onDelete}>
              <Trash size={15} aria-hidden />
              {t('delete')}
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {t('deleteNeedsManager')}
            </span>
          )}
          <button className="btn" onClick={p.onClose}>
            {t('close')}
          </button>
        </div>
      )}
    </Drawer>
  );
}
