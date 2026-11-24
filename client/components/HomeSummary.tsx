import { ArrowRight, Flag } from '@phosphor-icons/react';
import type { Health, MilestoneRow, MyAction, ProjectSummary } from '../../shared/types';
import { api } from '../api';
import { addDays } from '../../shared/dates';
import { progressKpi } from '../../shared/kpi';
import { navigate, useApp, useLoad } from '../lib/app';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { CountUp, stagger } from '../lib/motion';
import { Meter } from './ui';

// The summary at the top of the portfolio, cut to what each person answers for. Open projects only: a project
// closed long ago says nothing about today.
//  - PMO and executives: every project, and the milestones of all open projects (plus their own, if any).
//  - Someone who runs projects (owner or department head): those projects, their milestones, and the milestones
//    given to them in other projects.
//  - Everyone else: only the milestones given to them, and the next one due.

const HEALTH_COLOR: Record<Health, string> = {
  on_track: 'var(--ok)',
  at_risk: 'var(--warn)',
  off_track: 'var(--bad)',
  not_started: 'var(--line-strong)',
  done: 'var(--ink-2)',
};
const OPEN_HEALTH: Health[] = ['on_track', 'at_risk', 'off_track', 'not_started'];

interface Counts {
  total: number;
  done: number;
  open: number;
  overdue: number;
  soon: number;
}

function count(list: MilestoneRow[], today: string): Counts {
  const soonTo = addDays(today, 14);
  const open = list.filter((m) => m.status !== 'done');
  return {
    total: list.length,
    done: list.length - open.length,
    open: open.length,
    overdue: open.filter((m) => m.date < today).length,
    soon: open.filter((m) => m.date >= today && m.date <= soonTo).length,
  };
}

export function HomeSummary({
  scope,
  milestones,
  healthFilter,
  onHealth,
  openFilter,
  onOpenFilter,
  merged = false,
}: {
  scope: ProjectSummary[];
  milestones: MilestoneRow[] | null;
  healthFilter: Health | null;
  onHealth: (h: Health | null) => void;
  openFilter: 'open' | 'closed' | null;
  onOpenFilter: (v: 'open' | 'closed' | null) => void;
  /** With the category cards on top: projects and health in one box, and no Assigned to me line (its card shows it). */
  merged?: boolean;
}) {
  const { meta, can } = useApp();
  const { t, lang } = useT();
  const today = meta.today;
  const me = meta.me.id;
  const headOf = new Set(meta.departments.filter((d) => d.headUserId === me).map((d) => d.id));
  const runs = (p: ProjectSummary) => p.managerId === me || headOf.has(p.departmentId);
  const overview = can('projects.edit_all') || can('projects.view_all') || meta.managesPlan;
  const managed = scope.filter(runs);
  const role: 'overview' | 'manager' | 'member' = overview ? 'overview' : managed.length ? 'manager' : 'member';

  // Milestones that count: of open projects in reach, required, not cancelled.
  const inScope = new Set(scope.map((p) => p.id));
  const openIds = new Set(scope.filter((p) => p.health !== 'done').map((p) => p.id));
  const live = (milestones ?? []).filter((m) => inScope.has(m.projectId) && openIds.has(m.projectId) && !m.notRequired && m.status !== 'cancelled');
  const managedIds = new Set(managed.map((p) => p.id));
  const mine = live.filter((m) => m.mine);
  const next = mine.filter((m) => m.status !== 'done').sort((a, b) => a.date.localeCompare(b.date))[0];
  // What waits for this person's decision, for the line under the projects they run.
  const { data: actions } = useLoad(() => (role === 'manager' ? api.get<MyAction[]>('/api/my-actions') : Promise.resolve([] as MyAction[])), [role]);

  const line = (label: string, c: Counts, extra?: string) => (
    <div className="ms-line">
      <span className="ms-tag">{label}</span>
      <strong className="num">
        <CountUp value={c.total} />
      </strong>
      <span className="kpi-label">{extra ?? t('hs_total')}</span>
      <a className="chip" href="#/milestones?status=done">{t('hs_done', { n: c.done })}</a>
      <a className="chip" href="#/milestones?status=open">{t('hs_open', { n: c.open })}</a>
      {c.overdue > 0 && (
        <a className="chip is-bad" href="#/milestones?status=overdue">
          {t('hs_overdue', { n: c.overdue })}
        </a>
      )}
      {c.soon > 0 && <a className="chip" href="#/milestones?status=week">{t('hs_soon', { n: c.soon })}</a>}
    </div>
  );

  if (role === 'member') {
    const c = count(mine, today);
    const projects = new Set(mine.map((m) => m.projectId)).size;
    return (
      <section className="home-summary member enter" style={stagger(1)} aria-label={t('hs_myMilestones')}>
        <div className="hs-cell">
          <span className="hs-label">{t('hs_myMilestones')}</span>
          {milestones === null ? (
            <span className="kpi-label">…</span>
          ) : c.total === 0 ? (
            <span className="kpi-label">{t('hs_noneMine')}</span>
          ) : (
            <div className="hs-member">
              {line(t('hs_assigned'), c, t('hs_inProjects', { n: projects }))}
              {next && (
                <button className="hs-next" onClick={() => navigate(`/projects/${next.projectId}/plan?task=${next.id}`)}>
                  <Flag size={15} weight="fill" aria-hidden />
                  <span className="kpi-label">{t('hs_next')}</span>
                  <strong>{next.name}</strong>
                  <span className="kpi-label" style={{ color: next.date < today ? 'var(--bad)' : undefined }}>
                    {next.projectCode} · {fmtDate(next.date, lang)}
                  </span>
                  <ArrowRight size={14} aria-hidden />
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    );
  }

  // Projects, health and progress: all of them for the overview, those the person runs otherwise.
  const set = role === 'overview' ? scope : managed;
  const open = set.filter((p) => p.health !== 'done');
  const health = Object.fromEntries(OPEN_HEALTH.map((h) => [h, open.filter((p) => p.health === h).length])) as Record<Health, number>;
  const { actual: avg, expected } = progressKpi(open, today);
  const first = role === 'overview' ? count(live, today) : count(live.filter((m) => managedIds.has(m.projectId)), today);
  const second = role === 'overview' ? count(mine, today) : count(mine.filter((m) => !managedIds.has(m.projectId)), today);

  const projectsBlock = (
    <>
        <div className="hs-big">
          <strong className="num">
            <CountUp value={set.length} />
          </strong>
          <span className="kpi-label">{t('hs_total')}</span>
        </div>
        <div className="hs-chips">
          <button className="chip" aria-pressed={openFilter === 'open'} onClick={() => onOpenFilter(openFilter === 'open' ? null : 'open')}>
            {t('hs_openProjects', { n: open.length })}
          </button>
          <button className="chip" aria-pressed={openFilter === 'closed'} onClick={() => onOpenFilter(openFilter === 'closed' ? null : 'closed')}>
            {t('hs_closedProjects', { n: set.length - open.length })}
          </button>
        </div>
    </>
  );
  const healthBlock = (
    <>
        <div className="health-strip hs-strip" role="img" aria-label={OPEN_HEALTH.map((h) => `${t(`health_${h}`)} ${health[h]}`).join(', ')}>
          {OPEN_HEALTH.filter((h) => health[h] > 0).map((h) => (
            <span key={h} style={{ flex: health[h], background: HEALTH_COLOR[h] }} />
          ))}
        </div>
        <div className="hs-chips">
          {OPEN_HEALTH.filter((h) => health[h] > 0 || h !== 'not_started').map((h) => (
            <button key={h} className="chip" aria-pressed={healthFilter === h} onClick={() => onHealth(healthFilter === h ? null : h)}>
              <span className="dot" style={{ background: HEALTH_COLOR[h] }} />
              <span className="num">{health[h]}</span> {t(`health_${h}`)}
            </button>
          ))}
        </div>
    </>
  );

  return (
    <>
    <section className={`home-summary enter${role === 'manager' ? ' manager' : ''}${merged ? ' merged' : ''}`} style={stagger(1)} aria-label={t('health')}>
      {merged ? (
        <div className="hs-cell">
          <span className="hs-label">{t('hs_projectsHealth')}</span>
          {projectsBlock}
          {healthBlock}
        </div>
      ) : (
        <>
          <div className="hs-cell">
            <span className="hs-label">{role === 'overview' ? t('hs_projects') : t('hs_myProjects')}</span>
            {projectsBlock}
          </div>
          <div className="hs-cell">
            <span className="hs-label">{t('hs_health')}</span>
            {healthBlock}
          </div>
        </>
      )}
      <div className="hs-cell">
        <span className="hs-label" title={t('def_progress', { n: open.length })}>{t('hs_progress')}</span>
        <div className="hs-big">
          <strong className="num">
            <CountUp value={avg} />
            <small>%</small>
          </strong>
          <span className="kpi-label">{t('hs_doneWord')}</span>
        </div>
        <Meter value={avg} expected={expected} />
        <span className="kpi-label">{t('vsExpected', { n: expected })}</span>
      </div>
      <div className="hs-cell">
        <span className="hs-label" title={t('def_overdue')}>{t('hs_milestones')}</span>
        {milestones === null ? (
          <span className="kpi-label">…</span>
        ) : (
          <>
            {line(role === 'overview' ? t('hs_allOpen') : t('hs_iManage', { n: open.length }), first)}
            {role === 'overview' && !merged && second.total > 0 && line(t('hs_assigned'), second)}
            {role === 'manager' && <Waiting actions={actions} />}
          </>
        )}
      </div>
      {role === 'manager' && <AssignedCell mine={mine} managedIds={managedIds} today={today} loading={milestones === null} />}
    </section>
    {role === 'manager' && <NextMine mine={mine} managedIds={managedIds} today={today} />}
    </>
  );
}

/** What waits for this person's decision, in one line. */
function Waiting({ actions }: { actions: MyAction[] | null }) {
  const { t } = useT();
  if (!actions) return null;
  const sum = (k: MyAction['kind']) => actions.filter((a) => a.kind === k).reduce((n, a) => n + (a.count ?? 1), 0);
  const parts = [
    [sum('baseline'), 'hs_wDates'],
    [sum('date_change'), 'hs_wDateChanges'],
    [sum('change_request'), 'hs_wChanges'],
    [sum('escalation'), 'hs_wEscalations'],
    [sum('no_owner'), 'hs_wNoOwner'],
    [sum('owner_request'), 'hs_wOwnerAsks'],
    [sum('closure'), 'hs_wClosures'],
  ].filter(([n]) => (n as number) > 0) as [number, TKey][];
  return (
    <div className="hs-waiting">
      <span className="kpi-label">{t('hs_waiting')}</span>
      {parts.length === 0 ? <span className="kpi-label">{t('hs_wNothing')}</span> : parts.map(([n, k]) => <span key={k} className="hs-wait">{t(k, { n })}</span>)}
    </div>
  );
}

/** The milestones given to this person, in their projects and in others. */
function AssignedCell({ mine, managedIds, today, loading }: { mine: MilestoneRow[]; managedIds: Set<number>; today: string; loading: boolean }) {
  const { t } = useT();
  const open = mine.filter((m) => m.status !== 'done');
  const weekTo = addDays(today, 7);
  const late = open.filter((m) => m.date < today).length;
  const week = open.filter((m) => m.date >= today && m.date <= weekTo).length;
  const inMine = open.filter((m) => managedIds.has(m.projectId)).length;
  const elsewhere = open.filter((m) => !managedIds.has(m.projectId));
  return (
    <div className="hs-cell hs-mine">
      <a className="hs-label hs-mine-head" href="#/my-work">
        {t('hs_assigned')}
        <span>
          {t('hs_openMyWork')} <ArrowRight size={12} aria-hidden />
        </span>
      </a>
      {loading ? (
        <span className="kpi-label">…</span>
      ) : open.length === 0 ? (
        <span className="kpi-label">{t('hs_noneMine')}</span>
      ) : (
        <>
          <div className="hs-big">
            <strong className="num">
              <CountUp value={open.length} />
            </strong>
            <span className="kpi-label">{t('hs_openMs')}</span>
          </div>
          <div className="hs-chips">
            {late > 0 && <a className="chip is-bad" href="#/my-work">{t('hs_late', { n: late })}</a>}
            {week > 0 && <a className="chip is-warn" href="#/my-work">{t('hs_thisWeek', { n: week })}</a>}
            {open.length - late - week > 0 && <a className="chip" href="#/my-work">{t('hs_later', { n: open.length - late - week })}</a>}
          </div>
          <span className="kpi-label">{t(elsewhere.length ? 'hs_split' : 'hs_splitMine', { a: inMine, b: elsewhere.length, d: new Set(elsewhere.map((m) => m.departmentId)).size })}</span>
        </>
      )}
    </div>
  );
}

/** Their next milestones, wherever they are. */
function NextMine({ mine, managedIds, today }: { mine: MilestoneRow[]; managedIds: Set<number>; today: string }) {
  const { t, lang } = useT();
  const { meta } = useApp();
  const list = mine.filter((m) => m.status !== 'done').sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  if (!list.length) return null;
  const dept = (id: number) => meta.departments.find((d) => d.id === id);
  return (
    <section className="hs-next-list enter" style={stagger(2)} aria-label={t('hs_nextMine')}>
      <div className="hs-next-head">
        <strong>{t('hs_nextMine')}</strong>
        <span className="kpi-label">{t('hs_nextMineSub')}</span>
      </div>
      {list.map((m) => {
        const late = m.date < today ? Math.round((Date.parse(today) - Date.parse(m.date)) / 86_400_000) : 0;
        const d = dept(m.departmentId);
        return (
          <button key={m.id} className="hs-next-row" onClick={() => navigate(`/projects/${m.projectId}/plan?task=${m.id}`)}>
            <Flag size={14} weight={late ? 'fill' : 'regular'} aria-hidden style={{ color: late ? 'var(--bad)' : 'var(--ink-3)' }} />
            <span className="hs-next-name">
              {m.name} <span className="kpi-label">· {m.projectCode}</span>
            </span>
            <span className="kpi-label" style={{ color: late ? 'var(--bad)' : undefined }}>
              {late ? t('hs_daysLate', { n: late }) : fmtDate(m.date, lang)}
            </span>
            <span className="kpi-label">{managedIds.has(m.projectId) ? t('hs_myProject') : d ? (lang === 'ar' && d.nameAr ? d.nameAr : d.name) : ''}</span>
          </button>
        );
      })}
    </section>
  );
}
