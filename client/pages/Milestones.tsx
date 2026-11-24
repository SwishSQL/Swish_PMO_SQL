import { useMemo, useState } from 'react';
import { LEADS_PROJECTS } from '../../shared/permissions';
import { ALL_DATES, DateRange, inRange, overlaps } from '../components/DateRange';
import type { Range } from '../components/DateRange';
import { Buildings, FileXls, MagnifyingGlass, Rows, Warning } from '@phosphor-icons/react';
import type { MilestoneRow } from '../../shared/types';
import { addDays, diffDays } from '../../shared/dates';
import { api } from '../api';
import { navigate, useApp, useLoad, safeGet, safeSet } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate, projectName, relativeDays } from '../lib/format';
import { CountUp, stagger } from '../lib/motion';
import { milestoneFlags } from '../../shared/health';
import { MsLegend, MsPill, milestoneTone } from '../lib/milestoneTone';
import { deptColor, Empty, ErrorState, ExportButton, NameAvatar, PageSkeleton, Segmented } from '../components/ui';
import { LearnMore } from '../components/Tour';

type StatusFilter = 'overdue' | 'week' | 'stale' | 'warning' | 'open' | 'done' | 'all' | 'lateesc' | 'approval';
type TileFilter = Exclude<StatusFilter, 'lateesc' | 'approval'>;
const FILTERS: TileFilter[] = ['overdue', 'week', 'stale', 'warning', 'open', 'done', 'all'];
const PAGE = 60;

const NO_OWNER = '__none';

function hashParam(name: string): string | null {
  const m = window.location.hash.match(new RegExp(`[?&]${name}=([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Every milestone across the portfolio in one place, by deadline. The
 * department view answers "what does Accounting owe this month?" the way the
 * tracker's Departments page did.
 */
export function Milestones() {
  const { meta, dept, can } = useApp();
  const { t, lang } = useT();
  const today = meta.today;
  const { data: all, error, reload } = useLoad(() => api.get<MilestoneRow[]>('/api/milestones'), [], 'milestones');
  // A team member's page is their own milestones; whoever runs projects can switch between theirs and all of their
  // projects; the PMO and executives see everything.
  const overview = can('projects.view_all') || can('projects.edit_all');
  const teamMember = !overview && !LEADS_PROJECTS.some((p) => can(p));
  const [whose, setWhoseState] = useState<'mine' | 'all'>(() => (safeGet('pmo.msWhose') === 'mine' ? 'mine' : 'all'));
  const setWhose = (v: 'mine' | 'all') => (setWhoseState(v), safeSet('pmo.msWhose', v));
  // Mine | All only where it changes the list: some milestones are theirs and some are not (the PMO and executives too).
  const offerWhose = !teamMember && Boolean(all?.some((m) => m.mine) && all?.some((m) => !m.mine));
  const onlyMine = teamMember || (offerWhose && whose === 'mine');
  const data = useMemo(() => (all ? (onlyMine ? all.filter((m) => m.mine) : all) : null), [all, onlyMine]);
  const [view, setView] = useState<'list' | 'departments'>(() => (hashParam('view') === 'departments' ? 'departments' : 'list'));
  const [status, setStatus] = useState<StatusFilter>(() => (hashParam('status') as StatusFilter) || 'open');
  const [respDept, setRespDept] = useState<string>(() => hashParam('dept') ?? '');
  const [owner, setOwner] = useState<string>(() => (hashParam('owner') === 'none' ? NO_OWNER : ''));
  const [query, setQuery] = useState('');
  const [dates, setDates] = useState<Range>(ALL_DATES);
  const [limit, setLimit] = useState(PAGE);

  const isOpen = (m: MilestoneRow) => m.status !== 'done' && m.status !== 'cancelled';
  const isOverdue = (m: MilestoneRow) => isOpen(m) && m.date < today;
  const isThisWeek = (m: MilestoneRow) => isOpen(m) && m.date >= today && m.date <= addDays(today, 7);

  // Worked out once per load and day, not once per filter, count and row.
  const flagMap = useMemo(() => new Map((data ?? []).map((m) => [m.id, milestoneFlags(m, today)])), [data, today]);
  const flagsOf = (m: MilestoneRow) => flagMap.get(m.id) ?? milestoneFlags(m, today);
  const byStatus = (m: MilestoneRow, s: StatusFilter): boolean => {
    const f = flagsOf(m);
    switch (s) {
      case 'all':
        return true;
      case 'done':
        return m.status === 'done';
      case 'overdue':
        return isOverdue(m);
      case 'week':
        return isThisWeek(m);
      case 'stale':
        return f.needsUpdate;
      case 'warning':
        return f.earlyWarning || f.autoAtRisk;
      case 'lateesc':
        return f.escalationMissing || f.escalationLate;
      case 'approval':
        return m.pendingChanges > 0;
      default:
        return isOpen(m);
    }
  };

  const rows = useMemo(() => (data ?? []).filter((m) => inRange(m.date, dates)), [data, dates]);
  const counts = useMemo(
    () => ({
      overdue: rows.filter(isOverdue).length,
      week: rows.filter(isThisWeek).length,
      stale: rows.filter((m) => flagsOf(m).needsUpdate).length,
      warning: rows.filter((m) => flagsOf(m).earlyWarning || flagsOf(m).autoAtRisk).length,
      open: rows.filter(isOpen).length,
      done: rows.filter((m) => m.status === 'done').length,
      all: rows.length,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, today],
  );

  const owners = useMemo(() => [...new Set(rows.map((m) => m.ownerName).filter(Boolean) as string[])].sort(), [rows]);

  const depts = useMemo(() => {
    const map = new Map<string, { name: string; total: number; open: number; overdue: number; done: number; week: number }>();
    for (const m of rows) {
      const key = m.responsibleDept ?? t('unassignedDept');
      const d = map.get(key) ?? { name: key, total: 0, open: 0, overdue: 0, done: 0, week: 0 };
      d.total++;
      if (isOpen(m)) d.open++;
      if (isOverdue(m)) d.overdue++;
      if (isThisWeek(m)) d.week++;
      if (m.status === 'done') d.done++;
      map.set(key, d);
    }
    return [...map.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open || b.total - a.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, today, lang]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (m) =>
        byStatus(m, status) &&
        (!respDept || (m.responsibleDept ?? t('unassignedDept')) === respDept) &&
        (!owner || (owner === NO_OWNER ? !m.ownerName && !m.coOwners : m.ownerName === owner) || (m.coOwners ?? '').split(', ').includes(owner)) &&
        (!q || `${m.code ?? ''} ${m.name} ${m.projectCode} ${m.projectName} ${m.ownerName ?? ''}`.toLowerCase().includes(q)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, status, respDept, owner, query, today]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;

  const pickDept = (name: string) => {
    setRespDept(name);
    setView('list');
    setLimit(PAGE);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{teamMember ? t('myMilestonesTitle') : t('milestonesPage')}</h1>
          <LearnMore page="milestones" />
          <p className="page-sub">{t('milestonesSub', { n: rows.length, p: new Set(rows.map((m) => m.projectId)).size })}</p>
        </div>
        {offerWhose && (
          <Segmented
            label={t('pf_whose')}
            value={whose}
            onChange={setWhose}
            options={[
              { value: 'mine', label: t('myMilestonesTitle') },
              { value: 'all', label: overview ? t('msAllOverview') : t('msAllMine') },
            ]}
          />
        )}
        <Segmented
          label={t('milestonesPage')}
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: (<><Rows size={15} aria-hidden />{t('list')}</>) },
            { value: 'departments', label: (<><Buildings size={15} aria-hidden />{t('byResponsibleDept')}</>) },
          ]}
        />
      </div>

      <div className="ms-stats enter" style={stagger(1)}>
        {FILTERS.map((s) => (
          <button
            key={s}
            className={`ms-stat ${s === 'overdue' ? 'is-bad' : s === 'stale' || s === 'warning' ? 'is-warn' : ''}`}
            aria-pressed={status === s}
            onClick={() => {
              // Click the selected one again to clear it: back to Open (or to All, from Open).
              setStatus(status === s ? (s === 'open' ? 'all' : 'open') : s);
              setView('list');
              setLimit(PAGE);
            }}
          >
            <span className="figure num">
              <CountUp value={counts[s]} />
            </span>
            <span className="figure-label">{t(`msFilter_${s}`)}</span>
          </button>
        ))}
      </div>

      {view === 'departments' ? (
        <div className="dept-grid">
          {depts.map((d, i) => (
            <button key={d.name} className="dept-tile spotlight enter" style={stagger(i)} onClick={() => pickDept(d.name)}>
              <div className="dept-tile-head">
                <strong>{d.name}</strong>
                <span className="num muted">{d.total}</span>
              </div>
              <div className="health-strip" style={{ height: 6, marginTop: 12 }} aria-hidden>
                {d.done > 0 && <span style={{ flex: d.done, background: 'var(--ink-3)' }} />}
                {d.open - d.overdue > 0 && <span style={{ flex: d.open - d.overdue, background: 'var(--ok)' }} />}
                {d.overdue > 0 && <span style={{ flex: d.overdue, background: 'var(--bad)' }} />}
              </div>
              <div className="dept-tile-facts">
                <span>
                  <b className="num">{d.open}</b> {t('msFilter_open').toLowerCase()}
                </span>
                {d.week > 0 && (
                  <span>
                    <b className="num">{d.week}</b> {t('msFilter_week').toLowerCase()}
                  </span>
                )}
                {d.overdue > 0 && (
                  <span style={{ color: 'var(--bad)' }}>
                    <b className="num">{d.overdue}</b> {t('msFilter_overdue').toLowerCase()}
                  </span>
                )}
                <span className="muted">
                  <b className="num">{d.done}</b> {t('msFilter_done').toLowerCase()}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <>
          {(status === 'lateesc' || status === 'approval') && (
            <div className="active-filter">
              <span>{t(status === 'lateesc' ? 'filter_lateEsc' : 'filter_approval')}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setStatus('open')}>
                {t('clearFilters')}
              </button>
            </div>
          )}
          <div className="filters enter" style={stagger(2)}>
            <div className="search">
              <MagnifyingGlass size={16} aria-hidden />
              <input className="input" type="search" placeholder={t('searchMilestones')} aria-label={t('searchMilestones')} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <DateRange value={dates} onChange={(r) => (setDates(r), setLimit(PAGE))} today={today} />
            <select className="select" style={{ width: 'auto', minWidth: 220 }} value={respDept} aria-label={t('responsibleDept')} onChange={(e) => setRespDept(e.target.value)}>
              <option value="">{t('allResponsibleDepts', { n: depts.length })}</option>
              {[...depts].sort((a, b) => a.name.localeCompare(b.name)).map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} ({d.total})
                </option>
              ))}
            </select>
            <select className="select" style={{ width: 'auto', minWidth: 200 }} value={owner} aria-label={t('responsibleOwner')} onChange={(e) => setOwner(e.target.value)}>
              <option value="">{t('allOwners')}</option>
              <option value={NO_OWNER}>{t('unassigned')}</option>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {(respDept || owner || query) && (
              <button className="btn btn-ghost btn-sm" onClick={() => (setRespDept(''), setOwner(''), setQuery(''))}>
                {t('clearFilters')}
              </button>
            )}
            <span className="muted num" style={{ marginInlineStart: 'auto', fontSize: 13 }}>
              {filtered.length}
            </span>
            {/* Exactly the rows on screen, whatever the filters, with their update history. */}
            <ExportButton url="/api/export/milestones.xlsx" body={{ ids: filtered.map((m) => m.id) }} className="btn btn-sm" disabled={filtered.length === 0}>
              <FileXls size={15} aria-hidden />
              {t('exportExcel')}
            </ExportButton>
          </div>

          {filtered.length === 0 ? (
            <div className="panel">
              <Empty title={t('noMilestonesMatch')} />
            </div>
          ) : (
            <div className="panel table-wrap">
              <div style={{ padding: '12px 14px 0' }}>
                <MsLegend />
              </div>
              <table className="table ms-table">
                <thead>
                  <tr>
                    <th>{t('dueDate')}</th>
                    <th>{t('kind_milestone')}</th>
                    <th>{t('project')}</th>
                    <th>{t('responsibleOwner')}</th>
                    <th>{t('responsibleDept')}</th>
                    <th>{t('status')}</th>
                    <th>{t('latestUpdate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, limit).map((m, i) => {
                    const late = isOverdue(m);
                    const slip = m.baselineDate ? diffDays(m.baselineDate, m.date) : 0;
                    const d = dept(m.departmentId);
                    const tone = milestoneTone(m, today);
                    return (
                      <tr
                        key={m.id}
                        className={`${m.openable === false ? "row-locked" : "clickable"} enter`}
                        style={stagger(i)}
                        title={m.openable === false ? t("notYourTask") : undefined}
                        onClick={() => m.openable !== false && navigate(`/projects/${m.projectId}/plan?task=${m.id}`)}
                      >
                        <td className={`num ms-stripe ms-tone-${tone}`} style={{ whiteSpace: 'nowrap' }}>
                          <div style={{ fontWeight: 500, color: late ? 'var(--bad)' : undefined }}>{fmtDate(m.date, lang, true)}</div>
                          <div className="code">
                            {m.status === 'done' ? t('milestoneDone') : relativeDays(m.date, today, lang)}
                            {slip > 0 && <span style={{ color: 'var(--bad)' }}> +{slip}d</span>}
                          </div>
                        </td>
                        <td style={{ minWidth: 280, maxWidth: 420 }}>
                          {m.code && <div className="code">{m.code}</div>}
                          <div className="clamp-2" style={{ fontWeight: 500 }}>
                            {m.name}
                          </div>
                          {m.blocker && isOpen(m) && (
                            <div className="ms-blocker">
                              <Warning size={13} weight="fill" aria-hidden />
                              {m.blocker}
                            </div>
                          )}
                        </td>
                        <td style={{ minWidth: 180 }}>
                          <div className="code">
                            <span className="swatch" style={{ background: deptColor(d?.colorSlot), display: 'inline-block', marginInlineEnd: 6, verticalAlign: '-1px' }} />
                            {m.projectCode}
                          </div>
                          <div className="clamp-2 ink-2" style={{ fontSize: 13 }}>
                            {projectName({ name: m.projectName, nameAr: m.projectNameAr }, lang)}
                          </div>
                        </td>
                        <td style={{ minWidth: 150 }}>
                          {m.ownerName ? (
                            <span className="person">
                              <NameAvatar name={m.ownerName} size="sm" />
                              <span>{m.ownerName}</span>
                            </span>
                          ) : (
                            <span className="muted">-</span>
                          )}
                          {m.coOwners && <div className="code" style={{ marginTop: 2 }}>+ {m.coOwners}</div>}
                        </td>
                        <td className="ink-2" style={{ fontSize: 13 }}>{m.responsibleDept ?? '-'}</td>
                        <td>
                          <MsPill tone={tone} progress={m.progress} />
                          {(() => {
                            const f = flagsOf(m);
                            return (
                              <div className="flag-chips">
                                {f.earlyWarning && <span className="flag-chip warn">{t('flag_earlyWarning')}</span>}
                                {f.autoAtRisk && <span className="flag-chip warn">{t('flag_autoAtRisk')}</span>}
                                {f.needsUpdate && <span className="flag-chip">{t('flag_needsUpdate')}</span>}
                                {f.escalationMissing && <span className="flag-chip bad">{t('flag_escalationMissing')}</span>}
                                {f.escalationLate && <span className="flag-chip warn">{t('flag_escalationLate')}</span>}
                                {m.openEscalations > 0 && <span className="flag-chip">{t('flag_escalated')}</span>}
                                {m.pendingChanges > 0 && <span className="flag-chip warn">{t('flag_pendingChange')}</span>}
                              </div>
                            );
                          })()}
                        </td>
                        <td style={{ minWidth: 200, maxWidth: 320 }}>
                          {m.lastUpdateOn ? (
                            <>
                              <div className="code">{fmtDate(m.lastUpdateOn, lang)}</div>
                              {m.updateComment && <div className="clamp-2 ink-2" style={{ fontSize: 13 }}>{m.updateComment}</div>}
                            </>
                          ) : (
                            <span className="muted" style={{ fontSize: 13 }}>{t('neverUpdated')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length > limit && (
                <div className="panel-body" style={{ borderTop: '1px solid var(--line)', textAlign: 'center' }}>
                  <button className="btn" onClick={() => setLimit(limit + PAGE)}>
                    {t('showMore', { n: Math.min(PAGE, filtered.length - limit) })}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
