import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, CalendarX, Check, DotsThree, PaperPlaneRight, Siren, Trash, X } from '@phosphor-icons/react';
import type { DeadlineChange, Dependency, Escalation, EscalationStep, MilestoneUpdate, OwnerRequest, Task, TaskStatus, User } from '../../shared/types';
import { OwnerPicker } from './OwnerPicker';
import { spanDays } from '../../shared/dates';
import { api } from '../api';
import { useApp, useToast } from '../lib/app';
import { dayOffLabel, useCalendar } from '../lib/calendar';
import { useT } from '../lib/i18n';
import { confirmLeave, useUnsaved } from '../lib/unsaved';
import type { Key as TKey } from '../lib/i18n';
import { fmtDate, fmtDateTime } from '../lib/format';
import { stagger } from '../lib/motion';
import { Drawer, Field } from './ui';
import { DateInput } from './DateInput';
import { MentionTextarea } from './MentionTextarea';
import { MentionText } from './MentionText';
import { LearnMore } from './Tour';
import { TaskAttachments } from './TaskAttachments';

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
  /** Opened to complete it (status Done, 100%) or to reopen it: the update form starts there, the comment ready. */
  preset?: 'done' | 'reopen';
}

export function TaskPanel(p: Props) {
  const { t } = useT();
  const { task } = p;
  const [name, setName] = useState(task.name);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [progress, setProgress] = useState(task.progress);
  // A milestone with tasks under it takes its % from them.
  const fromTasks = task.kind === 'milestone' && p.tasks.some((x) => x.parentId === task.id && x.status !== 'cancelled');
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
  // A request for an owner from another department, waiting for its head (or a system admin).
  const [ownerAsk, setOwnerAsk] = useState<OwnerRequest | null>(null);
  const [askTick, setAskTick] = useState(0);
  useEffect(() => {
    if (!p.canGovern || task.kind === 'summary') return;
    let live = true;
    api
      .get<OwnerRequest[]>(`/api/projects/${task.projectId}/owner-requests`)
      .then((rs) => live && setOwnerAsk(rs.find((r) => r.taskId === task.id) ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [task.id, task.projectId, task.assigneeId, p.canGovern, task.kind, askTick]);
  const { lang } = useT();
  const { meta, can } = useApp();
  const cal = useCalendar();
  const toast = useToast();
  const [changes, setChanges] = useState<DeadlineChange[]>([]);
  const [escs, setEscs] = useState<Escalation[]>([]);
  const [steps, setSteps] = useState<EscalationStep[]>([]);
  const [escTo, setEscTo] = useState('');
  const [escNote, setEscNote] = useState('');
  const [escLevel, setEscLevel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);

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
    if (p.preset === 'done' && task.status !== 'done') {
      setStatus('done');
      setProgress(100);
    } else if (p.preset === 'reopen' && task.status === 'done') {
      setStatus('in_progress');
    }
    if (p.preset) window.setTimeout(() => commentRef.current?.focus(), 250);
  }, [p.preset, task.id, task.name, task.notes, task.progress, task.status, task.ownerName, task.coOwners, task.responsibleDept, task.escalateTo, task.blocker]);

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
      api.get<EscalationStep[]>(`/api/tasks/${id}/escalation-ladder`).catch(() => [] as EscalationStep[]),
    ]);
  const loadFollow = async (id: number) => {
    const [c, e, l] = await fetchFollow(id);
    setChanges(c);
    setEscs(e);
    setSteps(l);
  };
  useEffect(() => {
    let live = true;
    setChanges([]);
    setEscs([]);
    setEscNote('');
    setEscTo(task.escalateTo ?? '');
    if (task.kind !== 'summary') {
      fetchFollow(task.id).then(([c, e, l]) => {
        if (!live) return;
        setChanges(c);
        setEscs(e);
        setSteps(l);
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
      await api.post(`/api/tasks/${task.id}/escalations`, { note: escNote.trim() || null, level: can('projects.edit_all') && escLevel ? escLevel : undefined });
      setEscLevel(null);
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
  // Closing the panel with an update not posted asks first.
  const close = async () => {
    if (await confirmLeave()) p.onClose();
  };
  const discardUpdate = () => {
    setStatus(task.status);
    setProgress(task.progress);
    setBlocker(task.blocker ?? '');
    setComment('');
  };
  useUnsaved(dirty && p.canEdit, t('unsavedUpdateOf', { name: task.name }), () => post(), discardUpdate);
  const post = async (): Promise<boolean> => {
    setPosting(true);
    try {
      const saved = await p.onPatch({
        status,
        ...(fromTasks ? {} : { progress }),
        blocker: blocker.trim() || null,
        ...(comment.trim() ? { updateComment: comment.trim() } : {}),
      } as Partial<Task>);
      // Cancelled at the confirmation (or refused): what was typed stays.
      if (saved === null || saved === undefined) return false;
      setComment('');
      setLog(await loadLog(task.id));
      return true;
    } finally {
      setPosting(false);
    }
  };
  const authorOf = (u: MilestoneUpdate) => (u.authorId ? p.users.find((x) => x.id === u.authorId)?.name : null) ?? t('fromTrackerImport');

  const people = p.users.filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name));
  const personSelect = (value: string, onPick: (name: string | null) => void, label: string, empty: string) => (
    <select className="select" aria-label={label} value={value} disabled={lockPlan} onChange={(e) => onPick(e.target.value || null)}>
      <option value="">{empty}</option>
      {value && !people.some((u) => u.name === value) && <option value={value}>{t('noAccountName', { n: value })}</option>}
      {people.map((u) => (
        <option key={u.id} value={u.name}>
          {u.name}
        </option>
      ))}
    </select>
  );
  const coList = (task.coOwners ?? '')
    .split(/\s*[,،]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const deptNames = [...new Set([...meta.departments.map((d) => d.name), ...(task.responsibleDept ? [task.responsibleDept] : [])])];

  // Save a text field when focus leaves it, and only if it changed.
  const saveText = (key: keyof Task, value: string, current: string | null) =>
    value.trim() !== (current ?? '') && p.onPatch({ [key]: value.trim() || null } as Partial<Task>);

  const preds = p.dependencies.filter((d) => d.successorId === task.id);
  const byId = new Map(p.tasks.map((x) => [x.id, x]));
  const candidates = p.tasks.filter(
    (x) => x.id !== task.id && x.kind !== 'summary' && !preds.some((d) => d.predecessorId === x.id),
  );
  const ro = !p.canEdit;
  // The plan itself (name, dates, owner, links, notes) is the manager's: someone working on the task reports on it.
  const lockPlan = ro || !p.canGovern;
  const isSummary = task.kind === 'summary';
  // Someone working on the task without running the project: a short panel. The update first, the facts as one line,
  // the rest folded.
  const compact = !p.canGovern && !isSummary;
  // The project manager on a milestone or task: the state at a glance, the update first, the details folded.
  const managed = p.canGovern && !isSummary;
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openDetails = () => {
    const d = detailsRef.current;
    if (!d) return;
    d.open = true;
    d.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const todayIso = new Date().toISOString().slice(0, 10);
  const lateDays =
    task.status !== 'done' && task.status !== 'cancelled' && task.endDate < todayIso ? Math.round((Date.parse(todayIso) - Date.parse(task.endDate)) / 86_400_000) : 0;
  const detailsFold = (node: ReactNode) =>
    managed ? (
      <details className="fold" ref={detailsRef} data-tour="details">
        <summary>{t('details')}</summary>
        <div className="fold-body">{node}</div>
      </details>
    ) : (
      node
    );
  const fold = (label: string, open: boolean, node: ReactNode, tour?: string) =>
    compact || managed ? (
      <details className="fold" open={open} data-tour={tour}>
        <summary>{label}</summary>
        {node}
      </details>
    ) : tour ? (
      <div data-tour={tour}>{node}</div>
    ) : (
      node
    );
  const ownerLabel = task.ownerName ?? p.users.find((u) => u.id === task.assigneeId)?.name ?? null;
  const ownerShown = ownerAsk && !task.assigneeId ? `${t('op_waiting')}: ${ownerAsk.userName ?? ownerAsk.departmentName}` : (ownerLabel ?? t('unassigned'));

  return (
    <Drawer onClose={close} label={task.name}>
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
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
          <LearnMore page="task" />
          {managed && !ro && !task.systemKey && (
            <div
              className="mini-menu-wrap"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenuOpen(false);
              }}
            >
              <button className="btn btn-ghost btn-icon btn-sm" aria-label={t('tp_more')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
                <DotsThree size={18} weight="bold" />
              </button>
              {menuOpen && (
                <div className="mini-menu" role="menu">
                  <button role="menuitem" className="btn btn-ghost btn-sm btn-danger" onClick={() => (setMenuOpen(false), p.onDelete())}>
                    <Trash size={15} aria-hidden />
                    {t('delete')}
                  </button>
                </div>
              )}
            </div>
          )}
          <button className="btn btn-ghost btn-icon btn-sm" onClick={close} aria-label={t('close')}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="dialog-body" style={{ display: 'grid', gap: 18, flex: 1 }}>
        {managed && (
          <div className="state-chips">
            {lateDays > 0 && <span className="flag-chip bad">{t('tp_daysLate', { n: lateDays })}</span>}
            <span className="flag-chip">
              {t(`status_${task.status}`)} · {task.progress}%
            </span>
            {task.kind === 'milestone' && !task.baselineEnd && !task.systemKey && <span className="flag-chip warn">{t('tp_datesNotApproved')}</span>}
            {p.dependencies.length > 0 && (
              <span className={`flag-chip ${p.isCritical ? 'bad' : ''}`}>{p.isCritical ? t('onCriticalPath') : t('floatDays', { n: Math.max(0, p.floatDays ?? 0) })}</span>
            )}
          </div>
        )}
        {managed && (
          <div className="fact-tiles">
            {[
              [task.kind === 'milestone' ? t('dueDate') : t('finish'), fmtDate(task.endDate, lang, true)],
              [t('owner'), ownerShown],
              [t('responsibleDept'), task.responsibleDept || '-'],
              [t('escalateTo'), task.escalateTo || '-'],
            ].map(([k, v]) => (
              <button key={k} type="button" className="fact-tile" onClick={openDetails} title={t('tp_editInDetails')}>
                <span>{k}</span>
                <strong>{v}</strong>
              </button>
            ))}
          </div>
        )}

        {compact && (
          <p className="facts-line">
            {[
              `${t('dueDate')} ${fmtDate(task.endDate, lang, true)}`,
              ownerLabel && `${t('owner')} ${ownerLabel}`,
              task.coOwners && `${t('coOwners')} ${task.coOwners}`,
              task.responsibleDept,
              task.escalateTo && `${t('escalateTo')} ${task.escalateTo}`,
            ]
              .filter(Boolean)
              .map((x, i) => (
                <span key={i}>{x}</span>
              ))}
          </p>
        )}
        {isSummary && (
          <label className="field" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={task.notRequired} disabled={ro || !p.canGovern} onChange={(e) => p.onPatch({ notRequired: e.target.checked })} style={{ marginTop: 3 }} />
            <span>
              {t('notRequired')}
              <span className="hint" style={{ display: 'block' }}>{t('notRequiredHint')}</span>
            </span>
          </label>
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
              <Field label={`${t('progress')} ${progress}%`} hint={fromTasks ? t('progressFromTasks') : undefined}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={progress}
                  disabled={ro || fromTasks}
                  onChange={(e) => setProgress(Number(e.target.value))}
                  style={{ accentColor: 'var(--ink)', marginTop: 10 }}
                />
              </Field>
              <Field label={t('whatHappened')} hint={t('whatHappenedHint')} className="span-2">
                <MentionTextarea ref={commentRef} className="textarea" style={{ minHeight: 64 }} value={comment} disabled={ro} onChange={(e) => setComment(e.target.value)} />
              </Field>
              <Field label={t('blockerLabel')} hint={t('blockerHint')} className="span-2">
                <MentionTextarea className="textarea" style={{ minHeight: 48 }} value={blocker} disabled={ro} onChange={(e) => setBlocker(e.target.value)} />
              </Field>
            </div>
            {!ro && (
              <button className="btn btn-primary" style={{ justifySelf: 'start' }} disabled={posting || !dirty} onClick={post}>
                <PaperPlaneRight size={15} weight="bold" aria-hidden />
                {t('postUpdateBtn')}
              </button>
            )}
            {!ro && dirty && !posting && (
              <span className="not-posted" role="status">
                {t('notPostedYet')}
              </span>
            )}
            {log && log.length > 0 && (log[0].comment || log[0].blocker) && (
              <div className="latest-update">
                <span className="muted">
                  {t('latestUpdate')} · {authorOf(log[0])} · {log[0].authorId ? fmtDateTime(log[0].createdAt, lang) : fmtDate(log[0].createdAt.slice(0, 10), lang, true)}
                </span>
                {log[0].comment && (
                  <p>
                    <MentionText text={log[0].comment} />
                  </p>
                )}
                {log[0].blocker && (
                  <p className="update-log-blocker">
                    {t('blockerLabel')}: {log[0].blocker}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {!isSummary && (
          <TaskAttachments
            taskId={task.id}
            canGovern={!ro && p.canGovern}
            canAttach={
              !ro &&
              (p.canGovern ||
                task.assigneeId === meta.me.id ||
                (task.coOwners ?? '').split(/[,;\n]/).some((n) => n.trim().toLowerCase() === meta.me.name.trim().toLowerCase()))
            }
          />
        )}

        {task.kind === 'milestone' && !ro && !p.canGovern && <AskMove task={task} baselined={Boolean(p.baselined)} onSent={p.onReload} />}

        {detailsFold(
          <>
        {!compact && (
        <Field label={t('taskName')}>
          <input
            className="input"
            value={name}
            disabled={lockPlan}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== task.name && p.onPatch({ name: name.trim() })}
          />
        </Field>
        )}

        {!compact && !isSummary && (
          <div className="form-grid">
            <Field
              label={task.kind === 'milestone' ? t('dueDate') : t('start')}
              warn={dayOffLabel(cal, task.startDate, t, lang)}
              hint={task.kind === 'milestone' && p.baselined ? t('cr_milestoneLocked') : undefined}
            >
              <DateInput
                className="input"
                value={task.startDate}
                disabled={lockPlan || (task.kind === 'milestone' && p.baselined)}
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
                <DateInput
                  className="input"
                  value={task.endDate}
                  min={task.startDate}
                  disabled={lockPlan}
                  onChange={(e) => e.target.value && p.onPatch({ endDate: e.target.value })}
                />
              </Field>
            ) : null}
          </div>
        )}

        {!compact && !isSummary && (
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
                disabled={lockPlan}
                hidden={!lockPlan}
                onChange={(e) => {
                  const u = p.users.find((x) => x.id === Number(e.target.value));
                  p.onPatch({ assigneeId: u ? u.id : null, ownerName: u ? u.name : null });
                }}
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
              {!lockPlan && (
                <OwnerPicker
                  task={task}
                  users={p.users}
                  departmentId={p.departmentId}
                  disabled={lockPlan}
                  pending={ownerAsk}
                  onAssign={(u) => p.onPatch({ assigneeId: u ? u.id : null, ownerName: u ? u.name : null })}
                  onChanged={() => (setAskTick((n) => n + 1), p.onReload())}
                />
              )}
            </Field>
          </div>
        )}

        {!compact && !isSummary && (
          <div className="form-grid">
            {!task.assigneeId && ownerName && (
              <p className="muted span-2" style={{ margin: 0, fontSize: 12.5 }}>
                {t('trackerOwnerNote', { n: ownerName })}
              </p>
            )}
            <Field label={t('coOwners')} className="span-2">
              <div className="chips-pick">
                {coList.map((n) => (
                  <span key={n} className="flag-chip">
                    {n}
                    {!lockPlan && (
                      <button type="button" className="chip-x" aria-label={t('remove')} onClick={() => p.onPatch({ coOwners: coList.filter((x) => x !== n).join(', ') || null })}>
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {!lockPlan &&
                  personSelect('', (n) => n && !coList.includes(n) && p.onPatch({ coOwners: [...coList, n].join(', ') }), t('coOwners'), t('addCoOwner'))}
              </div>
            </Field>
            <Field label={t('responsibleDept')}>
              <select className="select" value={dept} disabled={lockPlan} onChange={(e) => (setDept(e.target.value), saveText('responsibleDept', e.target.value, task.responsibleDept))}>
                <option value="">-</option>
                {deptNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('escalateTo')}>
              {personSelect(escalate, (n) => (setEscalate(n ?? ''), saveText('escalateTo', n ?? '', task.escalateTo)), t('escalateTo'), '-')}
            </Field>
            {task.dependencyType && (
              <Field label={t('dependency')}>
                <input className="input" value={task.dependencyType.replace('_', ' ')} disabled readOnly />
              </Field>
            )}
          </div>
        )}

        {!compact && !isSummary && (
          <div className="field">
            <span>{t('predecessors')}</span>
            {preds.length === 0 && <div className="muted" style={{ fontSize: 13 }}>-</div>}
            {preds.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {byId.get(d.predecessorId)?.name}
                </span>
                {d.lagDays !== 0 && <span className="code">+{d.lagDays}d</span>}
                {!lockPlan && (
                  <button className="btn btn-ghost btn-sm btn-icon" aria-label={t('remove')} onClick={() => p.onRemoveDependency(d.id)}>
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            {!lockPlan && candidates.length > 0 && (
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

        {task.systemKey === 'closure_docs' && (
          <div className="closure-docs-box">
            <p style={{ margin: '0 0 8px' }}>{t('closureDocsHint')}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a className="btn btn-sm" href="/api/templates/closure-report" download>
                {t('closureReport')}
              </a>
              <a className="btn btn-sm" href="/api/templates/sign-off-checklist" download>
                {t('closureChecklist')}
              </a>
            </div>
          </div>
        )}

        {compact ? (task.notes ? fold(t('notes'), false, <p className="fold-text">{task.notes}</p>) : null) : (
        <Field label={t('notes')}>
          <MentionTextarea
            className="textarea"
            value={notes}
            disabled={lockPlan}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (task.notes ?? '') && p.onPatch({ notes })}
          />
        </Field>
        )}
          </>,
        )}

        {task.kind === 'milestone' && changes.length > 0 && fold(`${t('deadlineChanges')} (${changes.length})`, false, (
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
        ))}

        {!isSummary && fold(`${t('escalations')}${escs.length ? ` (${escs.length})` : ''}`, escs.some((e) => !e.resolvedAt), (
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
                    {e.note && (
                      <p>
                        <MentionText text={e.note} />
                      </p>
                    )}
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
            {steps.length > 0 && (
              <ol className="esc-ladder" aria-label={t('escLadder')}>
                {steps.map((st) => {
                  const openAt = Math.max(0, ...escs.filter((e) => !e.resolvedAt).map((e) => e.level));
                  return (
                    <li key={st.level} className={st.level <= openAt ? 'is-on' : st.level === openAt + 1 ? 'is-next' : ''}>
                      <span className="num">{st.level}</span>
                      <span>
                        <strong>{st.name}</strong>
                        <small>{t(`escRole_${st.role}` as TKey)}</small>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
            {steps.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{t('escClimbNote')}</div>}
            {!ro && (() => {
              const openAt = Math.max(0, ...escs.filter((e) => !e.resolvedAt).map((e) => e.level));
              // The PMO may pick a higher step (straight to the executives, say); others raise the next one.
              const pmo = can('projects.edit_all');
              const pickAt = pmo && escLevel && escLevel > openAt ? escLevel : openAt + 1;
              const next = steps[pickAt - 1];
              // A team member raises the first step; whoever runs the project takes it further.
              if (!next) return null;
              if (openAt >= 1 && !p.canGovern) return <div className="muted" style={{ fontSize: 13 }}>{t('escWithManager')}</div>;
              return (
                <div className="update-card" style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 13.5 }}>
                    {pmo && steps.length - openAt > 1 && (
                      <select className="select" style={{ width: 'auto', marginBottom: 6 }} aria-label={t('escPickLevel')} value={pickAt} onChange={(e) => setEscLevel(Number(e.target.value))}>
                        {steps.slice(openAt).map((st) => (
                          <option key={st.level} value={st.level}>
                            {t('escLevel', { n: st.level })} · {t(`escRole_${st.role}` as TKey)}
                          </option>
                        ))}
                      </select>
                    )}
                    <div>
                    {t('escGoesTo')} <strong>{next.name}</strong> <span className="muted">({t(`escRole_${next.role}` as TKey)})</span>
                    </div>
                    {!next.hasAccount && <div style={{ color: 'var(--warn)', fontSize: 12.5, marginTop: 4 }}>{t('escNoAccount')}</div>}
                  </div>
                  <Field label={t('escNote')}>
                    <MentionTextarea className="textarea" style={{ minHeight: 48 }} value={escNote} onChange={(e) => setEscNote(e.target.value)} />
                  </Field>
                  <button className="btn" style={{ justifySelf: 'start' }} disabled={busy || !escNote.trim()} onClick={raiseEscalation}>
                    <Siren size={15} aria-hidden />
                    {t('escRaise', { n: next.level })}
                  </button>
                </div>
              );
            })()}
          </div>
        ), 'escalations')}

        {!isSummary && fold(`${t('updateLog')}${log && log.length ? ` (${log.length})` : ''}`, false, (
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
                    {u.comment && (
                      <p>
                        <MentionText text={u.comment} />
                      </p>
                    )}
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
        ), 'updatelog')}

      </div>
      {!ro && !compact && (
        <div className="dialog-foot" style={{ justifyContent: 'space-between' }}>
          {managed ? (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {t('tp_autoSave')}
            </span>
          ) : task.systemKey ? null : p.canGovern ? (
            <button className="btn btn-ghost btn-danger" onClick={p.onDelete}>
              <Trash size={15} aria-hidden />
              {t('delete')}
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {t('detailsByManager')}
            </span>
          )}
          <button className="btn" onClick={close}>
            {t('close')}
          </button>
        </div>
      )}
    </Drawer>
  );
}

/** A team member cannot move a milestone: they ask the project manager, with the new date and the reason. */
function AskMove({ task, baselined, onSent }: { task: Task; baselined: boolean; onSent: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(task.endDate);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button className="btn btn-sm" data-tour="askmove" style={{ justifySelf: 'start' }} onClick={() => setOpen(true)}>
        <CalendarX size={15} aria-hidden /> {t('askMoveDate')}
      </button>
    );
  }
  const send = async () => {
    if (to === task.endDate || reason.trim().length < 5) {
      toast(t('askMoveNeeds'), 'bad');
      return;
    }
    setBusy(true);
    try {
      // On an approved baseline the date changes by a change request; before it, as a move waiting for approval.
      if (baselined) {
        await api.post(`/api/projects/${task.projectId}/changes`, {
          description: `Move "${task.name}" from ${task.endDate} to ${to}`,
          reason: reason.trim(),
          areas: ['schedule'],
          changes: { milestones: [{ taskId: task.id, action: 'move', to }] },
        });
      } else {
        await api.patch(`/api/tasks/${task.id}`, { endDate: to, changeReason: reason.trim() });
      }
      toast(t('askMoveSent'));
      setOpen(false);
      setReason('');
      onSent();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="update-card" aria-label={t('askMoveDate')}>
      <strong>{t('askMoveDate')}</strong>
      <div className="form-grid">
        <Field label={t('askMoveTo')}>
          <DateInput className="input" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </Field>
        <Field label={t('askMoveWhy')} className="span-2">
          <MentionTextarea className="textarea" style={{ minHeight: 56 }} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" disabled={busy} onClick={send}>
          {t('askMoveSend')}
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          {t('cancel')}
        </button>
      </div>
    </section>
  );
}
