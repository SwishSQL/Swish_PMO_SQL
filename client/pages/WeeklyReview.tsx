import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CountUp, EASE_OUT, stagger } from '../lib/motion';
import { ArrowRight, CaretLeft, CaretRight, PencilSimple, Presentation, X } from '@phosphor-icons/react';
import type { Health, MeetingNote, NoteKind, ProjectSummary, StatusUpdate } from '../../shared/types';
import { addDays, weekStart } from '../../shared/dates';
import { expectedProgress } from '../../shared/schedule';
import { api } from '../api';
import { navigate, useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { deptName, fmtDate, fmtDateTime, projectName } from '../lib/format';
import { UpdateDialog } from '../components/UpdateDialog';
import { UpdateBody } from './ProjectPage';
import { deptColor, Empty, ErrorState, HealthBadge, HealthIcon, Meter, PageSkeleton, Person, Segmented } from '../components/ui';

interface WeekData {
  week: string;
  updates: StatusUpdate[];
  previous: StatusUpdate[];
}

const RANK: Record<Health, number> = { off_track: 0, at_risk: 1, not_started: 3, on_track: 2, done: 4 };

function weekFromHash(fallback: string): string {
  const m = window.location.hash.match(/week=(\d{4}-\d{2}-\d{2})/);
  return m ? weekStart(m[1]) : fallback;
}

export function WeeklyReview({ meeting }: { meeting: boolean }) {
  const { meta, quarterId, user, can } = useApp();
  const { t, lang } = useT();
  const thisWeek = weekStart(meta.today);
  const [week, setWeek] = useState(() => weekFromHash(thisWeek));
  const [writing, setWriting] = useState<ProjectSummary | null>(null);
  const projects = useLoad(() => api.get<ProjectSummary[]>(`/api/projects?quarter=${quarterId ?? ''}`), [quarterId], 'projects-quarter');
  const updates = useLoad(() => api.get<WeekData>(`/api/updates?week=${week}`), [week]);

  const goWeek = (w: string) => {
    setWeek(w);
    window.history.replaceState(null, '', `#/updates${meeting ? '/meeting' : ''}?week=${w}`);
  };

  const rows = useMemo(() => {
    if (!projects.data || !updates.data) return [];
    const byProject = new Map(updates.data.updates.map((u) => [u.projectId, u]));
    const prev = new Map(updates.data.previous.map((p) => [p.projectId, p]));
    return projects.data
      .filter((p) => p.startDate <= addDays(week, 6) && p.stage !== 'closed')
      .map((p) => ({ p, u: byProject.get(p.id) ?? null, prev: prev.get(p.id) ?? null }))
      .sort((a, b) => RANK[a.u?.health ?? a.p.health] - RANK[b.u?.health ?? b.p.health] || a.p.code.localeCompare(b.p.code));
  }, [projects.data, updates.data, week]);

  const err = projects.error ?? updates.error;
  if (err) return <ErrorState message={err} onRetry={() => { projects.reload(); updates.reload(); }} />;
  if (!projects.data || !updates.data) return <PageSkeleton />;

  const filed = rows.filter((r) => r.u).length;
  const canWrite = (p: ProjectSummary) =>
    can('projects.edit_all') || (can('updates.write') && can('projects.edit_own') && p.managerId === meta.me.id);

  if (meeting) {
    return (
      <Meeting
        rows={rows}
        week={week}
        onExit={() => navigate(`/updates?week=${week}`)}
        onNoteAdded={() => updates.reload()}
      />
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('weeklyReview')}</h1>
          <p className="page-sub">{t('updatesFiled', { n: filed, total: rows.length })}</p>
        </div>
        <div className="toolbar">
          <div className="week-nav">
            <button className="btn btn-ghost btn-icon" onClick={() => goWeek(addDays(week, -7))} aria-label={t('previousWeek')}>
              {lang === 'ar' ? <CaretRight size={16} /> : <CaretLeft size={16} />}
            </button>
            <span className="week-label">{t('weekOf', { d: fmtDate(week, lang, true) })}</span>
            <button className="btn btn-ghost btn-icon" onClick={() => goWeek(addDays(week, 7))} aria-label={t('nextWeek')} disabled={week >= thisWeek}>
              {lang === 'ar' ? <CaretLeft size={16} /> : <CaretRight size={16} />}
            </button>
          </div>
          <button className="btn btn-primary" onClick={() => navigate(`/updates/meeting?week=${week}`)} disabled={rows.length === 0}>
            <Presentation size={16} aria-hidden />
            {t('startMeeting')}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="panel">
          <Empty title={t('noProjectsTitle')} />
        </div>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('project')}</th>
                <th>{t('manager')}</th>
                <th>{t('health')}</th>
                <th>{t('progress')}</th>
                <th>{t('decisions')}</th>
                <th>{t('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, u, prev }, i) => {
                const d = meta.departments.find((x) => x.id === p.departmentId);
                const delta = u && prev ? u.progress - prev.progress : null;
                return (
                  <tr key={p.id} className="enter" style={stagger(i)}>
                    <td>
                      <a className="cell-project" href={`#/projects/${p.id}/updates`} style={{ textDecoration: 'none' }}>
                        <span className="code">
                          <span className="swatch" style={{ background: deptColor(d?.colorSlot), display: 'inline-block', marginInlineEnd: 6, verticalAlign: '-1px' }} />
                          {p.code} {deptName(d, lang)}
                        </span>
                        <strong>{projectName(p, lang)}</strong>
                      </a>
                    </td>
                    <td>
                      <Person user={user(p.managerId)} name={p.managerName} />
                    </td>
                    <td>
                      {u ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {prev && prev.health !== u.health && (
                            <>
                              <span className={`h-${prev.health}`} title={t(`health_${prev.health}`)} style={{ display: 'inline-flex', opacity: 0.6 }}>
                                <HealthIcon health={prev.health} size={14} />
                              </span>
                              <ArrowRight size={12} className="muted" style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} aria-hidden />
                            </>
                          )}
                          <HealthBadge health={u.health} />
                        </span>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td className="num">
                      {u ? `${u.progress}%` : '-'}
                      {delta !== null && delta !== 0 && (
                        <span style={{ fontSize: 12, marginInlineStart: 6, color: delta > 0 ? 'var(--ok)' : 'var(--bad)' }}>
                          {delta > 0 ? '+' : ''}
                          {delta}
                        </span>
                      )}
                    </td>
                    <td style={{ maxWidth: 280 }}>
                      {u?.decisions ? (
                        <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontWeight: 500 }}>{u.decisions}</span>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td>
                      {u ? (
                        <span className="ink-2" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                          {t('filed')} {fmtDateTime(u.submittedAt, lang)}
                        </span>
                      ) : (
                        <span className="pill h-at_risk">{t('pending')}</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'end' }}>
                      {canWrite(p) && week === thisWeek && (
                        <button className="btn btn-sm" onClick={() => setWriting(p)}>
                          <PencilSimple size={14} aria-hidden />
                          {u ? t('edit') : t('writeUpdate')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {writing && (
        <UpdateDialog
          projectId={writing.id}
          projectLabel={`${writing.code} ${projectName(writing, lang)}`}
          week={week}
          existing={rows.find((r) => r.p.id === writing.id)?.u}
          planProgress={writing.progress}
          currentHealth={writing.health}
          onClose={() => setWriting(null)}
          onSaved={() => {
            setWriting(null);
            updates.reload();
            projects.reload();
          }}
        />
      )}
    </>
  );
}

// ---- Meeting mode -------------------------------------------------------------
// One project per screen, worst news first, notes captured as decisions and
// actions against the update they were raised on.

function Meeting({
  rows,
  week,
  onExit,
  onNoteAdded,
}: {
  rows: { p: ProjectSummary; u: StatusUpdate | null; prev: StatusUpdate | null }[];
  week: string;
  onExit: () => void;
  onNoteAdded: () => void;
}) {
  const { meta, user } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const [i, setI] = useState(0);
  const [kind, setKind] = useState<NoteKind>('decision');
  // One draft per project: a half-typed note stays with the project it was
  // written for when the agenda moves on, and is there again on coming back.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [extra, setExtra] = useState<Record<number, MeetingNote[]>>({});
  const row = rows[Math.min(i, rows.length - 1)];
  // Slide forward or back depending on which way the agenda moved.
  const prevI = useRef(i);
  const dir = i >= prevI.current ? 1 : -1;
  useEffect(() => {
    prevI.current = i;
  }, [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const fwd = lang === 'ar' ? 'ArrowLeft' : 'ArrowRight';
      const back = lang === 'ar' ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === fwd || e.key === 'j') setI((x) => Math.min(rows.length - 1, x + 1));
      if (e.key === back || e.key === 'k') setI((x) => Math.max(0, x - 1));
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows.length, onExit, lang]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  if (!row) return null;
  const { p, u, prev } = row;
  const d = meta.departments.find((x) => x.id === p.departmentId);
  const expected = expectedProgress(p.startDate, p.endDate, meta.today);
  const next = p.milestones.find((m) => !m.done);
  // Notes just added show at once; the reload that follows brings the same
  // rows back, so keep one copy of each.
  const notes = [...(u?.notes ?? []), ...(u ? extra[u.id] ?? [] : [])].filter(
    (n, idx, all) => all.findIndex((x) => x.id === n.id) === idx,
  );

  const text = drafts[p.id] ?? '';
  const setText = (value: string) => setDrafts((d) => ({ ...d, [p.id]: value }));

  const addNote = async () => {
    if (!u || !text.trim()) return;
    // Captured now: the agenda may move while the request is in flight.
    const projectId = p.id;
    try {
      const n = await api.post<MeetingNote>(`/api/updates/${u.id}/notes`, { kind, body: text.trim() });
      setExtra((x) => ({ ...x, [u.id]: [...(x[u.id] ?? []), n] }));
      setDrafts((d) => ({ ...d, [projectId]: '' }));
      onNoteAdded();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  return (
    <div className="meeting" role="dialog" aria-modal="true" aria-label={t('weeklyReview')}>
      <aside className="meeting-agenda">
        <div style={{ padding: '0 10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong>{t('agenda')}</strong>
          <span className="code">{t('weekOf', { d: fmtDate(week, lang) })}</span>
        </div>
        {rows.map((r, idx) => (
          <button key={r.p.id} className="agenda-item" aria-current={idx === i} onClick={() => setI(idx)}>
            <span className={`h-${r.u?.health ?? 'not_started'}`} style={{ display: 'inline-flex' }}>
              <HealthIcon health={r.u?.health ?? 'not_started'} size={15} />
            </span>
            <span className="agenda-name">{projectName(r.p, lang)}</span>
            <span className="code">{r.p.code.replace('PRJ-', '')}</span>
          </button>
        ))}
        <div style={{ marginTop: 'auto', padding: '16px 10px 0', fontSize: 12, color: 'var(--ink-3)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <kbd>{lang === 'ar' ? '→' : '←'}</kbd>
          <kbd>{lang === 'ar' ? '←' : '→'}</kbd>
          <kbd>Esc</kbd>
        </div>
      </aside>

      <section className="meeting-stage">
        <div className="meeting-top" style={{ position: 'relative', zIndex: 1 }}>
          <span className="code">{t('ofN', { i: Math.min(i, rows.length - 1) + 1, n: rows.length })}</span>
          <div className="toolbar">
            <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>
              {t('back')}
            </button>
            <button className="btn btn-primary" disabled={i >= rows.length - 1} onClick={() => setI(i + 1)}>
              {t('next')}
            </button>
            <button className="btn btn-ghost" onClick={onExit}>
              <X size={16} aria-hidden />
              {t('exitMeeting')}
            </button>
          </div>
        </div>

        <AnimatePresence mode="wait" custom={dir}>
        <motion.div
          key={p.id}
          custom={dir}
          variants={{
            enter: (d: number) => ({ opacity: 0, x: d * (lang === 'ar' ? -48 : 48) }),
            center: { opacity: 1, x: 0 },
            exit: (d: number) => ({ opacity: 0, x: d * (lang === 'ar' ? 48 : -48) }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.38, ease: EASE_OUT }}
        >
        <div className="code">
          <span className="swatch" style={{ background: deptColor(d?.colorSlot), display: 'inline-block', marginInlineEnd: 6, verticalAlign: '-1px' }} />
          {p.code} {deptName(d, lang)}
        </div>
        <h2 className="meeting-title">{projectName(p, lang)}</h2>
        <div style={{ marginTop: 12, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <Person user={user(p.managerId)} name={p.managerName} size="lg" />
          {u ? <HealthBadge health={u.health} pill /> : <span className="pill h-at_risk">{t('pending')}</span>}
          {prev && u && prev.health !== u.health && (
            <span className="muted" style={{ fontSize: 13 }}>
              {t('previousWeek')}: {t(`health_${prev.health}`)}
            </span>
          )}
        </div>

        <div className="big-figures">
          <div>
            <div className="figure num" style={{ fontSize: 44, letterSpacing: '-0.035em' }}>
              <CountUp value={u?.progress ?? p.progress} duration={0.9} />
              <small>%</small>
            </div>
            <div className="figure-label">{t('progress')}</div>
            <div style={{ width: 200, marginTop: 8 }}>
              <Meter value={u?.progress ?? p.progress} expected={expected} />
            </div>
            <div className="figure-note">
              {expected - (u?.progress ?? p.progress) > 3
                ? t('behindBy', { n: expected - (u?.progress ?? p.progress) })
                : t('vsTime', { n: expected })}
            </div>
          </div>
          <div>
            <div className="figure num" style={{ fontSize: 22, paddingTop: 5 }}>
              {fmtDate(p.endDate, lang, true)}
            </div>
            <div className="figure-label">{t('finish')}</div>
            {p.baselineEnd && p.baselineEnd < p.endDate && (
              <div className="figure-note" style={{ color: 'var(--bad)' }}>
                {t('movedFrom', { d: fmtDate(p.baselineEnd, lang) })}
              </div>
            )}
          </div>
          {next && (
            <div style={{ maxWidth: 280 }}>
              <div className="figure num" style={{ fontSize: 22, paddingTop: 5, color: next.date < meta.today ? 'var(--bad)' : undefined }}>
                {fmtDate(next.date, lang)}
              </div>
              <div className="figure-label">{t('nextMilestone')}</div>
              <div className="figure-note">{next.name}</div>
            </div>
          )}
        </div>

        <div className="meeting-cols">
          <div>
            {u ? (
              <UpdateBody u={u} />
            ) : prev ? (
              <>
                <p className="pill h-at_risk" style={{ margin: '0 0 16px' }}>
                  {t('noUpdateYet')} {t('showingLastWeek')}
                </p>
                <div style={{ opacity: 0.8 }}>
                  <UpdateBody u={prev} />
                </div>
              </>
            ) : (
              <p className="muted">{t('noUpdateYet')}</p>
            )}
          </div>
          <div className="panel" style={{ alignSelf: 'start' }}>
            <div className="panel-head">
              <h3 className="panel-title">{t('meetingNotes')}</h3>
            </div>
            <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
              {notes.length === 0 && <span className="muted" style={{ fontSize: 13 }}>-</span>}
              {notes.map((n) => (
                <div key={n.id} className="note" style={{ padding: 0 }}>
                  <span className={`note-kind k-${n.kind}`}>{t(n.kind)}</span>
                  <span>{n.body}</span>
                </div>
              ))}
              {u && (
                <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
                  <Segmented
                    label={t('addNote')}
                    value={kind}
                    onChange={setKind}
                    options={(['decision', 'action', 'comment'] as NoteKind[]).map((k) => ({ value: k, label: t(k) }))}
                  />
                  <textarea
                    className="textarea"
                    style={{ minHeight: 64 }}
                    value={text}
                    aria-label={t('addNote')}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addNote();
                    }}
                  />
                  <button className="btn btn-primary" style={{ justifySelf: 'start' }} disabled={!text.trim()} onClick={addNote}>
                    {t('addNote')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        </motion.div>
        </AnimatePresence>
      </section>
    </div>
  );
}
