import { useEffect, useState } from 'react';
import { ArrowsOutSimple, CalendarCheck, ChatsCircle, CheckCircle, FileText, Gavel, Plus, Prohibit, Siren, Sparkle, WarningCircle, WarningOctagon } from '@phosphor-icons/react';
import type { MeetingNote, NoteKind, StatusUpdate } from '../../shared/types';
import { api } from '../api';
import { useApp, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate, fmtDateTime } from '../lib/format';
import { todayIso } from '../../shared/dates';
import { DateInput } from './DateInput';
import { Dialog, Segmented } from './ui';
import { MentionTextarea } from './MentionTextarea';

// One project in the weekly meeting: every part is shown, and an empty one says so (no blockers is news too).
// A tile opens in a large popup with everything in it, and with what the meeting can act on there and then:
// raise or clear a blocker, close a milestone, move it, give it to someone else, resolve an escalation, decide.
// The notes of the meeting are taken here by the PMO whether or not the update was filed; an action has an owner
// and a due date, and comes back each week until it is done.

interface Item {
  id: number;
  name: string;
  due: string;
  owner: string | null;
  progress?: number;
}
interface TaskBlocker {
  id: number;
  name: string;
  blocker: string;
  status: string;
  due: string;
  owner: string | null;
}
interface Brief {
  week: string;
  update: (StatusUpdate & { thisWeek: boolean }) | null;
  blockers: TaskBlocker[];
  projectBlockers: MeetingNote[];
  openTasks: { id: number; name: string; kind: string; due: string }[];
  comments: { id: number; task: string; comment: string; at: string; author: string }[];
  overdue: Item[];
  dueThisWeek: Item[];
  escalations: { id: number; task: string; level: number; to: string; at: string }[];
  decisions: { kind: 'deadline' | 'change' | 'ask'; id: number; text: string; reason: string; owner?: string | null; due?: string | null }[];
  notes: MeetingNote[];
  openActions: MeetingNote[];
  canNote: boolean;
}

type Tone = 'bad' | 'warn' | 'info' | 'ok' | 'neutral';
type Open = 'ai' | 'update' | 'blockers' | 'overdue' | 'due' | 'escalations' | 'comments' | 'decisions';

function Tile({
  tone,
  icon,
  title,
  count,
  none,
  noneTone = 'ok',
  className = '',
  onOpen,
  extra,
  children,
}: {
  tone: Tone;
  icon: React.ReactNode;
  title: string;
  count: number;
  none: string;
  noneTone?: 'ok' | 'warn';
  className?: string;
  onOpen?: () => void;
  extra?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { t } = useT();
  const empty = count === 0;
  const opens = !!onOpen && !empty;
  return (
    <section
      className={`mb-tile t-${empty ? noneTone : tone} ${opens ? 'opens' : ''} ${className}`}
      onClick={opens ? onOpen : undefined}
      onKeyDown={opens ? (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), onOpen!()) : undefined}
      role={opens ? 'button' : undefined}
      tabIndex={opens ? 0 : undefined}
      title={opens ? t('mbViewAll') : undefined}
    >
      <header>
        <span className="mb-icon">{icon}</span>
        <h4>{title}</h4>
        {extra}
        {!empty && <span className="mb-count num">{count}</span>}
        {opens && <ArrowsOutSimple className="mb-expand" size={14} aria-hidden />}
      </header>
      {empty ? (
        <p className="mb-none">
          {noneTone === 'ok' ? <CheckCircle size={18} weight="fill" aria-hidden /> : <WarningCircle size={18} weight="fill" aria-hidden />}
          {none}
        </p>
      ) : (
        <div className="mb-body">{children}</div>
      )}
    </section>
  );
}

/** The first rows that fit; the rest is in the popup. */
function Rows<T>({ items, render }: { items: T[]; render: (x: T) => React.ReactNode }) {
  return <ul className="mb-rows">{items.slice(0, 4).map(render)}</ul>;
}

/** A milestone in the popup: close it, set its %, move it (with a reason), or give it to someone else. */
function MilestoneRow({ m, late, canEdit, run }: { m: Item; late: boolean; canEdit: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const { meta } = useApp();
  const { t, lang } = useT();
  const [edit, setEdit] = useState(false);
  const [pct, setPct] = useState(String(m.progress ?? 0));
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState<number | ''>('');
  const save = async () => {
    const body: Record<string, unknown> = {};
    if (Number(pct) !== (m.progress ?? 0)) body.progress = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (date && date !== m.due) Object.assign(body, { endDate: date, changeReason: reason.trim() });
    if (owner) body.assigneeId = owner;
    if (!Object.keys(body).length) return setEdit(false);
    if (await run(() => api.patch(`/api/tasks/${m.id}`, body), t('mbSaved'))) setEdit(false);
  };
  return (
    <li className="md-row">
      <div className="md-main">
        <b>{m.name}</b>
        <span className="mb-meta">
          <span style={{ color: late ? 'var(--bad)' : undefined }}>{fmtDate(m.due, lang, true)}</span> · {m.owner ?? '-'} · {m.progress ?? 0}%
        </span>
        {edit && (
          <div className="md-edit">
            <label>
              <span>{t('mbProgress')}</span>
              <input className="input" type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} />
            </label>
            <label>
              <span>{t('mbNewDate')}</span>
              <DateInput value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              <span>{t('mbReassign')}</span>
              <select className="select" value={owner} onChange={(e) => setOwner(e.target.value ? Number(e.target.value) : '')}>
                <option value="">{t('mbKeepOwner')}</option>
                {meta.users
                  .filter((x) => x.active)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
            </label>
            {date && date !== m.due && (
              <label className="md-wide">
                <span>{t('mbReason')}</span>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            )}
            <div className="md-wide toolbar">
              <button className="btn btn-sm" onClick={() => setEdit(false)}>
                {t('cancel')}
              </button>
              <button className="btn btn-sm btn-primary" disabled={!!date && date !== m.due && reason.trim().length < 5} onClick={save}>
                {t('save')}
              </button>
            </div>
          </div>
        )}
      </div>
      {canEdit && !edit && (
        <div className="md-acts">
          <button className="btn btn-sm" onClick={() => setEdit(true)}>
            {t('mbEdit')}
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => run(() => api.patch(`/api/tasks/${m.id}`, { status: 'done' }), t('mbSaved'))}>
            {t('mbMarkDone')}
          </button>
        </div>
      )}
    </li>
  );
}

function AskRow({ d, week, projectId, canEdit, run }: { d: Brief['decisions'][number]; week: string; projectId: number; canEdit: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const { t, lang } = useT();
  const [deciding, setDeciding] = useState(false);
  const [outcome, setOutcome] = useState('');
  const decide = () =>
    run(async () => {
      await api.post(`/api/projects/${projectId}/meeting-notes`, { week, kind: 'decision', body: `${d.text} → ${outcome.trim()}` });
      await api.patch(`/api/notes/${d.id}`, { done: true });
    }, t('mbSaved'));
  return (
    <li className="md-row">
      <div className="md-main">
        <b>{d.text}</b>
        <span className="mb-meta" style={{ color: d.due && d.due < todayIso() ? 'var(--bad)' : undefined }}>
          {t('mbDecides')}: {d.owner ?? '-'}
          {d.due ? ` · ${t('dueOn', { d: fmtDate(d.due, lang, true) })}` : ''}
        </span>
        {deciding && (
          <div className="md-edit" style={{ gridTemplateColumns: '1fr' }}>
            <label>
              <span>{t('mbOutcome')}</span>
              <input className="input" autoFocus value={outcome} onChange={(e) => setOutcome(e.target.value)} />
            </label>
            <div className="toolbar">
              <button className="btn btn-sm" onClick={() => setDeciding(false)}>
                {t('cancel')}
              </button>
              <button className="btn btn-sm btn-primary" disabled={!outcome.trim()} onClick={decide}>
                {t('save')}
              </button>
            </div>
          </div>
        )}
      </div>
      {canEdit && !deciding && (
        <div className="md-acts">
          <button className="btn btn-sm btn-primary" onClick={() => setDeciding(true)}>
            {t('mbMarkDecided')}
          </button>
        </div>
      )}
    </li>
  );
}

export function MeetingBrief({ projectId, week, onNoteAdded }: { projectId: number; week: string; onNoteAdded: () => void }) {
  const { meta } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const [data, setData] = useState<Brief | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summing, setSumming] = useState(false);
  const [kind, setKind] = useState<NoteKind>('decision');
  const [text, setText] = useState('');
  const [ownerId, setOwnerId] = useState<number | ''>('');
  const [due, setDue] = useState('');
  const [open, setOpen] = useState<Open | null>(null);
  const [bTarget, setBTarget] = useState<number | ''>('');
  const [bText, setBText] = useState('');
  const [eTask, setETask] = useState<number | ''>('');
  const [eTo, setETo] = useState('');
  const [eNote, setENote] = useState('');
  const [aText, setAText] = useState('');
  const [aOwner, setAOwner] = useState<number | ''>('');
  const [aDue, setADue] = useState('');

  const load = () =>
    api
      .get<Brief>(`/api/projects/${projectId}/meeting?week=${week}`)
      .then(setData)
      .catch((e) => toast((e as Error).message, 'bad'));
  useEffect(() => {
    setData(null);
    setSummary(null);
    setText('');
    setOpen(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, week]);

  if (!data) return <div className="skeleton" style={{ flex: 1, borderRadius: 12, marginTop: 16 }} />;

  const canEdit = data.canNote;
  /** One change made in the meeting: done, the brief and the page around it are fresh again. */
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      await load();
      onNoteAdded();
      return true;
    } catch (e) {
      toast((e as Error).message, 'bad');
      return false;
    }
  };

  const add = async () => {
    if (!text.trim()) return;
    try {
      await api.post(`/api/projects/${projectId}/meeting-notes`, { week, kind, body: text.trim(), ...(kind === 'action' ? { ownerId: ownerId || null, dueDate: due || null } : {}) });
      setText('');
      setOwnerId('');
      setDue('');
      onNoteAdded();
      load();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const toggle = async (n: MeetingNote) => {
    try {
      await api.patch(`/api/notes/${n.id}`, { done: !n.doneAt });
      load();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const summarize = async () => {
    setSumming(true);
    try {
      setSummary((await api.post<{ summary: string }>(`/api/projects/${projectId}/meeting-summary`, { week })).summary);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setSumming(false);
    }
  };
  const addBlocker = async () => {
    const body = bText.trim();
    if (!body) return;
    const ok = bTarget
      ? await run(() => {
          // A milestone already blocked keeps what was said before, the new blocker under it.
          const old = data.blockers.find((b) => b.id === bTarget)?.blocker?.trim();
          return api.patch(`/api/tasks/${bTarget}`, { blocker: old ? `${old}\n${body}` : body });
        }, t('mbBlockerAdded'))
      : await run(() => api.post(`/api/projects/${projectId}/meeting-notes`, { week, kind: 'blocker', body }), t('mbBlockerAdded'));
    if (ok) {
      setBText('');
      setBTarget('');
    }
  };
  const escalate = async () => {
    if (!eTask || !eTo) return;
    if (await run(() => api.post(`/api/tasks/${eTask}/escalations`, { toName: eTo, note: eNote.trim() || null }), t('mbEscalated'))) {
      setETask('');
      setETo('');
      setENote('');
    }
  };
  const ask = async () => {
    if (!aText.trim() || !aOwner) return;
    if (await run(() => api.post(`/api/projects/${projectId}/meeting-notes`, { week, kind: 'decision_needed', body: aText.trim(), ownerId: aOwner, dueDate: aDue || null }), t('mbAsked'))) {
      setAText('');
      setAOwner('');
      setADue('');
    }
  };
  const people = meta.users.filter((x) => x.active);
  const addButton = (to: Open, label: string) =>
    canEdit && (
      <button
        className="btn btn-sm mb-add"
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(to);
        }}
      >
        <Plus size={13} aria-hidden />
      </button>
    );
  const clearTaskBlocker = (b: TaskBlocker) =>
    run(() => api.patch(`/api/tasks/${b.id}`, { blocker: null, ...(b.status === 'blocked' ? { status: 'in_progress' } : {}) }), t('mbBlockerCleared'));

  const noteRow = (n: MeetingNote) => (
    <div key={n.id} className="note" style={{ padding: 0, alignItems: 'flex-start' }}>
      {n.kind === 'action' && (
        <input type="checkbox" checked={!!n.doneAt} aria-label={t('actionDone')} onChange={() => toggle(n)} style={{ marginTop: 4 }} disabled={!data.canNote} />
      )}
      <span className={`note-kind k-${n.kind}`}>{t(n.kind)}</span>
      <span style={{ textDecoration: n.doneAt ? 'line-through' : undefined }}>
        {n.body}
        {n.kind === 'action' && (n.ownerName || n.dueDate) && (
          <span className="muted" style={{ display: 'block', fontSize: 12 }}>
            {[n.ownerName, n.dueDate && t('dueOn', { d: fmtDate(n.dueDate, lang, true) })].filter(Boolean).join(' · ')}
          </span>
        )}
        <span className="note-stamp">{[n.authorName, fmtDateTime(n.createdAt, lang)].filter(Boolean).join(' · ')}</span>
      </span>
    </div>
  );
  const u = data.update;
  const blockerCount = data.blockers.length + data.projectBlockers.length;
  const UPDATE_PARTS = (
    [
      ['accomplishments', u?.accomplishments],
      ['nextSteps', u?.nextSteps],
      ['blockers', u?.blockers],
      ['decisions', u?.decisions],
    ] as const
  );

  const dialog = () => {
    switch (open) {
      case 'ai':
        return <p className="md-text" style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--ink)' }}>{summary}</p>;
      case 'update':
        return (
          u && (
            <div className="md-update">
              {UPDATE_PARTS.map(([k, v]) => (
                <div key={k}>
                  <span className="mb-label">{t(k as never)}</span>
                  <p className="md-text">{v?.trim() ? v : <span className="muted">{t('mbNothingSaid')}</span>}</p>
                </div>
              ))}
            </div>
          )
        );
      case 'blockers':
        return (
          <>
            {canEdit && (
              <div className="md-add">
                <strong>{t('mbAddBlocker')}</strong>
                <select className="select" aria-label={t('mbBlockerOn')} value={bTarget} onChange={(e) => setBTarget(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">{t('mbWholeProject')}</option>
                  {data.openTasks.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.kind === 'milestone' ? '◆ ' : ''}
                      {x.name} · {fmtDate(x.due, lang, true)}
                    </option>
                  ))}
                </select>
                <MentionTextarea className="textarea" style={{ minHeight: 60 }} placeholder={t('mbBlockerText')} value={bText} onChange={(e) => setBText(e.target.value)} />
                <button className="btn btn-primary btn-sm" style={{ justifySelf: 'start' }} disabled={!bText.trim()} onClick={addBlocker}>
                  <Plus size={14} aria-hidden /> {t('mbAddBlocker')}
                </button>
              </div>
            )}
            {blockerCount === 0 && <p className="mb-none" style={{ color: 'var(--ok)' }}>{t('mbNoBlockers')}</p>}
            <ul className="md-list">
              {data.projectBlockers.map((n) => (
                <li key={`n${n.id}`} className="md-row">
                  <div className="md-main">
                    <b>{t('mbWholeProject')}</b>
                    <p className="md-text">{n.body}</p>
                    <span className="mb-meta">
                      {[n.authorName, fmtDateTime(n.createdAt, lang)].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {canEdit && (
                    <div className="md-acts">
                      <button className="btn btn-sm" onClick={() => run(() => api.patch(`/api/notes/${n.id}`, { done: true }), t('mbBlockerCleared'))}>
                        {t('mbClear')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
              {data.blockers.map((b) => (
                <li key={b.id} className="md-row">
                  <div className="md-main">
                    <b>{b.name}</b>
                    <p className="md-text">{b.blocker || t('status_blocked')}</p>
                    <span className="mb-meta">
                      {fmtDate(b.due, lang, true)} · {b.owner ?? '-'}
                    </span>
                  </div>
                  {canEdit && (
                    <div className="md-acts">
                      <button className="btn btn-sm" onClick={() => clearTaskBlocker(b)}>
                        {t('mbClear')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        );
      case 'overdue':
      case 'due':
        return (
          <ul className="md-list">
            {(open === 'overdue' ? data.overdue : data.dueThisWeek).map((m) => (
              <MilestoneRow key={m.id} m={m} late={open === 'overdue'} canEdit={canEdit} run={run} />
            ))}
          </ul>
        );
      case 'escalations':
        return (
          <>
          {canEdit && (
            <div className="md-add t-bad">
              <strong>{t('mbEscalate')}</strong>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <select className="select" aria-label={t('mbEscalateWhat')} value={eTask} onChange={(e) => setETask(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">{t('mbEscalateWhat')}…</option>
                  {data.openTasks.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.kind === 'milestone' ? '◆ ' : ''}
                      {x.name} · {fmtDate(x.due, lang, true)}
                    </option>
                  ))}
                </select>
                <select className="select" aria-label={t('mbEscalateTo')} value={eTo} onChange={(e) => setETo(e.target.value)}>
                  <option value="">{t('mbEscalateTo')}…</option>
                  {people.map((x) => (
                    <option key={x.id} value={x.name}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </div>
              <MentionTextarea className="textarea" style={{ minHeight: 56 }} placeholder={t('mbEscalateWhy')} value={eNote} onChange={(e) => setENote(e.target.value)} />
              <button className="btn btn-primary btn-sm" style={{ justifySelf: 'start' }} disabled={!eTask || !eTo} onClick={escalate}>
                <Plus size={14} aria-hidden /> {t('mbEscalate')}
              </button>
            </div>
          )}
          {data.escalations.length === 0 && <p className="mb-none" style={{ color: 'var(--ok)' }}>{t('mbNoEscalations')}</p>}
          <ul className="md-list">
            {data.escalations.map((e) => (
              <li key={e.id} className="md-row">
                <div className="md-main">
                  <b>{e.task}</b>
                  <span className="mb-meta">
                    {t('levelN', { n: e.level })} → {e.to} · {fmtDateTime(e.at, lang)}
                  </span>
                </div>
                {canEdit && (
                  <div className="md-acts">
                    <button className="btn btn-sm btn-primary" onClick={() => run(() => api.post(`/api/escalations/${e.id}/resolve`, {}), t('mbSaved'))}>
                      {t('mbResolve')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          </>
        );
      case 'comments':
        return (
          <ul className="md-list">
            {data.comments.map((c) => (
              <li key={c.id} className="md-row">
                <div className="md-main">
                  <b>{c.task}</b>
                  <p className="md-text">{c.comment}</p>
                  <span className="mb-meta">
                    {c.author} · {fmtDateTime(c.at, lang)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        );
      case 'decisions':
        return (
          <>
          {canEdit && (
            <div className="md-add">
              <strong>{t('mbAskDecision')}</strong>
              <MentionTextarea className="textarea" style={{ minHeight: 56 }} placeholder={t('mbAskWhat')} value={aText} onChange={(e) => setAText(e.target.value)} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <select className="select" aria-label={t('mbDecides')} value={aOwner} onChange={(e) => setAOwner(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">{t('mbDecides')}…</option>
                  {people.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <DateInput aria-label={t('dueDate')} value={aDue} onChange={(e) => setADue(e.target.value)} />
              </div>
              <button className="btn btn-primary btn-sm" style={{ justifySelf: 'start' }} disabled={!aText.trim() || !aOwner} onClick={ask}>
                <Plus size={14} aria-hidden /> {t('mbAskDecision')}
              </button>
            </div>
          )}
          {data.decisions.length === 0 && <p className="mb-none" style={{ color: 'var(--ok)' }}>{t('mbNoDecisions')}</p>}
          <ul className="md-list">
            {data.decisions.map((d) => {
              if (d.kind === 'ask') return <AskRow key={`ask${d.id}`} d={d} week={week} projectId={projectId} canEdit={canEdit} run={run} />;
              const url = d.kind === 'deadline' ? `/api/deadline-changes/${d.id}/decide` : `/api/changes/${d.id}/decide`;
              return (
                <li key={`${d.kind}${d.id}`} className="md-row">
                  <div className="md-main">
                    <b>{d.text}</b>
                    {d.reason && <p className="md-text">{d.reason}</p>}
                  </div>
                  {canEdit && (
                    <div className="md-acts">
                      <button className="btn btn-sm" onClick={() => run(() => api.post(url, { decision: 'reject' }), t('mbSaved'))}>
                        {t('mbReject')}
                      </button>
                      <button className="btn btn-sm btn-primary" onClick={() => run(() => api.post(url, { decision: 'approve' }), t('mbSaved'))}>
                        {t('mbApprove')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          </>
        );
      default:
        return null;
    }
  };
  const TITLES: Record<Open, string> = {
    ai: t('aiBrief'),
    update: t('mbUpdate'),
    blockers: t('mbBlockers'),
    overdue: t('mbOverdue'),
    due: t('mbDueThisWeek'),
    escalations: t('mbEscalations'),
    comments: t('mbComments'),
    decisions: t('mbDecisions'),
  };

  return (
    <div className="mb-wrap">
      <div className="mb-main">
        <div
          className={`mb-ai ${summary ? 'has opens' : ''}`}
          onClick={summary ? () => setOpen('ai') : undefined}
          onKeyDown={summary ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen('ai')) : undefined}
          role={summary ? 'button' : undefined}
          tabIndex={summary ? 0 : undefined}
          title={summary ? t('mbViewAll') : undefined}
        >
          <Sparkle size={16} weight="fill" aria-hidden />
          {summary ? (
            <>
              <p className="clamp-2">{summary}</p>
              <ArrowsOutSimple className="mb-expand" size={14} aria-hidden />
            </>
          ) : (
            <button className="btn btn-sm" disabled={summing} onClick={summarize}>
              {summing ? t('thinking') : t('aiBrief')}
            </button>
          )}
        </div>

        <div className="mb-grid">
          <Tile
            className="span-2"
            tone={u?.thisWeek ? 'ok' : 'warn'}
            noneTone="warn"
            icon={<FileText size={18} weight="duotone" />}
            title={u?.thisWeek ? t('mbUpdate') : u ? t('mbUpdateOldShort', { d: fmtDate(u.weekStart, lang, true) }) : t('mbUpdate')}
            count={u ? 1 : 0}
            none={t('mbNoUpdateEver')}
            onOpen={() => setOpen('update')}
          >
            {u && (
              <div className="mb-update">
                {UPDATE_PARTS.map(([k, v]) => (
                  <div key={k}>
                    <span className="mb-label">{t(k as never)}</span>
                    <span className="clamp-2">{v?.trim() ? v : <span className="muted">{t('mbNothingSaid')}</span>}</span>
                  </div>
                ))}
              </div>
            )}
          </Tile>

          <Tile
            tone="warn"
            icon={<Prohibit size={18} weight="duotone" />}
            title={t('mbBlockers')}
            count={blockerCount}
            none={t('mbNoBlockers')}
            onOpen={() => setOpen('blockers')}
            extra={addButton('blockers', t('mbAddBlocker'))}
          >
            <Rows
              items={[
                ...data.projectBlockers.map((n) => ({ key: `n${n.id}`, name: t('mbWholeProject'), text: n.body })),
                ...data.blockers.map((b) => ({ key: `t${b.id}`, name: b.name, text: b.blocker || t('status_blocked') })),
              ]}
              render={(b) => (
                <li key={b.key}>
                  <b className="clamp-1">{b.name}</b>
                  <span className="mb-meta clamp-1">{b.text}</span>
                </li>
              )}
            />
          </Tile>

          <Tile tone="bad" icon={<WarningOctagon size={18} weight="duotone" />} title={t('mbOverdue')} count={data.overdue.length} none={t('mbNoOverdue')} onOpen={() => setOpen('overdue')}>
            <Rows
              items={data.overdue}
              render={(m) => (
                <li key={m.id}>
                  <b className="clamp-1">{m.name}</b>
                  <span className="mb-meta">
                    <span style={{ color: 'var(--bad)' }}>{fmtDate(m.due, lang, true)}</span> · {m.owner ?? '-'} · {m.progress}%
                  </span>
                </li>
              )}
            />
          </Tile>

          <Tile tone="info" icon={<CalendarCheck size={18} weight="duotone" />} title={t('mbDueThisWeek')} count={data.dueThisWeek.length} none={t('mbNothingDue')} onOpen={() => setOpen('due')}>
            <Rows
              items={data.dueThisWeek}
              render={(m) => (
                <li key={m.id}>
                  <b className="clamp-1">{m.name}</b>
                  <span className="mb-meta">
                    {fmtDate(m.due, lang, true)} · {m.owner ?? '-'} · {m.progress}%
                  </span>
                </li>
              )}
            />
          </Tile>

          <Tile tone="bad" icon={<Siren size={18} weight="duotone" />} title={t('mbEscalations')} count={data.escalations.length} none={t('mbNoEscalations')} onOpen={() => setOpen('escalations')} extra={addButton('escalations', t('mbEscalate'))}>
            <Rows
              items={data.escalations}
              render={(e) => (
                <li key={e.id}>
                  <b className="clamp-1">{e.task}</b>
                  <span className="mb-meta">
                    {t('levelN', { n: e.level })} → {e.to}
                  </span>
                </li>
              )}
            />
          </Tile>

          <Tile className="span-2" tone="neutral" icon={<ChatsCircle size={18} weight="duotone" />} title={t('mbComments')} count={data.comments.length} none={t('mbNoComments')} onOpen={() => setOpen('comments')}>
            <Rows
              items={data.comments}
              render={(c) => (
                <li key={c.id}>
                  <b className="clamp-1">{c.task}</b>
                  <span className="mb-meta clamp-1">
                    {c.comment} <span className="muted">· {c.author} · {fmtDateTime(c.at, lang)}</span>
                  </span>
                </li>
              )}
            />
          </Tile>

          <Tile tone="warn" icon={<Gavel size={18} weight="duotone" />} title={t('mbDecisions')} count={data.decisions.length} none={t('mbNoDecisions')} onOpen={() => setOpen('decisions')} extra={addButton('decisions', t('mbAskDecision'))}>
            <Rows
              items={data.decisions}
              render={(d) => (
                <li key={`${d.kind}${d.id}`}>
                  <b className="clamp-1">{d.text}</b>
                  {d.kind === 'ask' ? (
                    <span className="mb-meta clamp-1">
                      {t('mbDecides')}: {d.owner ?? '-'}
                      {d.due ? ` · ${fmtDate(d.due, lang, true)}` : ''}
                    </span>
                  ) : (
                    d.reason && <span className="mb-meta clamp-1">{d.reason}</span>
                  )}
                </li>
              )}
            />
          </Tile>
        </div>
      </div>

      <div className="panel mb-notes">
        <div className="panel-head">
          <h3 className="panel-title">{t('meetingNotes')}</h3>
        </div>
        <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
          {data.openActions.length > 0 && (
            <>
              <strong style={{ fontSize: 12.5 }}>{t('mbOpenActions')}</strong>
              {data.openActions.map(noteRow)}
              <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '4px 0' }} />
            </>
          )}
          {data.notes.length === 0 && <span className="muted" style={{ fontSize: 13 }}>{t('mbNoNotes')}</span>}
          {data.notes.map(noteRow)}
          {data.canNote && (
            <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
              <Segmented label={t('addNote')} value={kind} onChange={setKind} options={(['decision', 'action', 'comment'] as NoteKind[]).map((k) => ({ value: k, label: t(k) }))} />
              <MentionTextarea
                className="textarea"
                style={{ minHeight: 64 }}
                value={text}
                aria-label={t('addNote')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add();
                }}
              />
              {kind === 'action' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <select className="select" aria-label={t('owner')} value={ownerId} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">{t('owner')}…</option>
                    {meta.users
                      .filter((x) => x.active)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                  <DateInput aria-label={t('dueDate')} value={due} onChange={(e) => setDue(e.target.value)} />
                </div>
              )}
              <button className="btn btn-primary" style={{ justifySelf: 'start' }} disabled={!text.trim()} onClick={add}>
                {t('addNote')}
              </button>
            </div>
          )}
        </div>
      </div>

      {open && (
        <Dialog title={TITLES[open]} onClose={() => setOpen(null)} width={820}>
          <div className="md-body">{dialog()}</div>
        </Dialog>
      )}
    </div>
  );
}
