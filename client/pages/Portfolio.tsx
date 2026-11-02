import { useMemo, useState } from 'react';
import { ChatCircleText, FileXls, LinkSimple, MagnifyingGlass, Plus, Path, Rows, Sparkle } from '@phosphor-icons/react';
import type { Capability, Health, ProjectSummary, Quarter } from '../../shared/types';
import { HEALTHS } from '../../shared/types';
import { addDays, diffDays, weekStart } from '../../shared/dates';
import { expectedProgress } from '../../shared/schedule';
import { api } from '../api';
import { navigate, safeGet, safeSet, useApp, useLoad } from '../lib/app';
import { useT } from '../lib/i18n';
import { deptName, fmtDate, projectName } from '../lib/format';
import { RouteLegend, RouteMap } from '../components/RouteMap';
import { deptColor, Empty, ErrorState, ExportButton, HealthBadge, Meter, PageSkeleton, Person, Segmented } from '../components/ui';
import { NewProjectDialog } from '../components/NewProject';
import { AiProjectDialog } from '../components/AiProject';
import { AskPortfolioDialog } from '../components/AskPortfolio';
import { TrackerUpdateButton } from '../components/TrackerUpdate';
import { GroupGrid, ImportPlanButton, InitiativeDetail, InitiativeList, LinkDialog, Trail, initiativesAt, locate, parseLevel, projectsOf } from '../components/PlanBrowser';
import { CountUp, spotlight, stagger } from '../lib/motion';

const HEALTH_COLOR: Record<Health, string> = {
  on_track: 'var(--ok)',
  at_risk: 'var(--warn)',
  off_track: 'var(--bad)',
  not_started: 'var(--line-strong)',
  done: 'var(--ink-2)',
};

/**
 * The Portfolio, the way the PMO's Transformation Capabilities workbook reads: the capabilities, then a capability's
 * dimensions, then a dimension's plan projects with the projects that deliver them, then one plan project. The
 * figures and the projects below always cover where the person is.
 */
export function Portfolio({ path = [] }: { path?: string[] }) {
  const { meta, dept, user, canCreateIn, can } = useApp();
  const { t, lang } = useT();
  const [view, setView] = useState<'map' | 'list'>(() => (safeGet('pmo.view') === 'list' ? 'list' : 'map'));
  const [deptFilter, setDeptFilter] = useState<number | null>(null);
  const [healthFilter, setHealthFilter] = useState<Health | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  // The assistant needs an API key on the server: without one its button is not shown.
  const ai = useLoad(() => api.get<{ enabled: boolean; variables?: string[] }>('/api/ai/status'), [], 'ai-status');
  const { data, error, reload } = useLoad(() => api.get<ProjectSummary[]>('/api/projects?quarter='), [], 'projects-all');
  const planLoad = useLoad(() => api.get<Capability[]>('/api/transformation'), [], 'plan');
  const plan = planLoad.data ?? [];
  const level = parseLevel(path);
  const where = locate(plan, level);
  const byId = useMemo(() => new Map((data ?? []).map((p) => [p.id, p])), [data]);
  // The projects in reach: all of them at the top, else those under the capability, dimension or plan project.
  const scope = useMemo(
    () => (level.kind === 'root' ? data ?? [] : projectsOf(initiativesAt(plan, level), byId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, plan, path.join('/')],
  );
  const unlinked = (data ?? []).filter((p) => !p.initiativeId);
  const today = meta.today;
  // The route map's window: two months back, four ahead.
  const window: Quarter = { id: 0, code: '', year: 0, q: 0, startsOn: `${addDays(today, -60).slice(0, 8)}01`, endsOn: addDays(`${addDays(today, 125).slice(0, 8)}01`, -1) };
  const usersById = useMemo(() => new Map(meta.users.map((u) => [u.id, u])), [meta.users]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scope.filter(
      (p) =>
        (!unlinkedOnly || !p.initiativeId) &&
        (!deptFilter || p.departmentId === deptFilter) &&
        (!healthFilter || p.health === healthFilter) &&
        (!q || `${p.code} ${p.name} ${p.nameAr ?? ''}`.toLowerCase().includes(q)),
    );
  }, [scope, deptFilter, healthFilter, query, unlinkedOnly]);

  const changeView = (v: 'map' | 'list') => {
    setView(v);
    safeSet('pmo.view', v);
  };

  const canCreate = meta.departments.some((d) => canCreateIn(d.id));

  const head = (
    <div className="page-head">
      <div>
        {level.kind !== 'root' && <Trail plan={plan} level={level} />}
        <h1 className="page-title">{where.initiative?.name ?? where.dimension?.name ?? where.capability?.name ?? t('portfolio')}</h1>
        <p className="page-sub">
          {level.kind === 'root'
            ? t('planRootSub', { c: plan.length, p: plan.reduce((n, c) => n + c.dimensions.reduce((m, d) => m + d.initiatives.length, 0), 0) })
            : t('planScopeSub', { n: scope.length })}
        </p>
        {ai.data && !ai.data.enabled && can('projects.edit_all') && (
          <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }} role="status">
            {t('aiOff', { v: ai.data.variables?.length ? ai.data.variables.join(', ') : t('aiOffNone') })}
          </p>
        )}
      </div>
      <div className="toolbar">
        {/* The quarter on screen, or every project as the old tracker's export gave it. */}
        <div className="export-menu">
          <ExportButton url="/api/export/portfolio.xlsx?quarter=all">
            <FileXls size={16} aria-hidden />
            {t('exportExcel')}
          </ExportButton>
        </div>
        {can('projects.edit_all') && <ImportPlanButton onDone={planLoad.reload} />}
        {can('projects.edit_all') && (
          <TrackerUpdateButton
            onDone={() => {
              reload();
              planLoad.reload();
            }}
          />
        )}
        {ai.data?.enabled && (
          <button className="btn" onClick={() => setAsking(true)}>
            <ChatCircleText size={16} weight="fill" aria-hidden />
            {t('askPortfolio')}
          </button>
        )}
        {canCreate && ai.data?.enabled && (
          <button className="btn" onClick={() => setChatting(true)}>
            <Sparkle size={16} weight="fill" aria-hidden />
            {t('aiCreate')}
          </button>
        )}
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} weight="bold" aria-hidden />
            {t('newProject')}
          </button>
        )}
      </div>
    </div>
  );

  const askDialog = asking && <AskPortfolioDialog onClose={() => setAsking(false)} />;

  const chatDialog = chatting && (
    <AiProjectDialog
      onClose={() => setChatting(false)}
      onCreated={(id) => {
        setChatting(false);
        navigate(`/projects/${id}/plan`);
      }}
    />
  );

  const dialog = creating && (
    <NewProjectDialog
      onClose={() => setCreating(false)}
      onCreated={(id) => {
        setCreating(false);
        navigate(`/projects/${id}/plan`);
      }}
    />
  );

  if (error) return (<>{head}<ErrorState message={error} onRetry={reload} /></>);
  if (!data || !planLoad.data) return <PageSkeleton />;
  const reloadAll = () => {
    reload();
    planLoad.reload();
  };
  const linkDialog = linking && (
    <LinkDialog
      plan={plan}
      onClose={() => setLinking(false)}
      onSaved={() => {
        setLinking(false);
        reloadAll();
      }}
    />
  );

  if (data.length === 0 && plan.length === 0) {
    return (
      <>
        {head}
        <div className="panel">
          <Empty
            title={t('noProjectsTitle')}
            body={t('noProjectsBody')}
            action={
              canCreate && (
                <button className="btn btn-primary" onClick={() => setCreating(true)}>
                  <Plus size={16} weight="bold" aria-hidden />
                  {t('newProject')}
                </button>
              )
            }
          />
        </div>
        {dialog}
        {chatDialog}
        {askDialog}
      </>
    );
  }

  // ---- The verdict: how the quarter is going, in four reads ----
  const counts = Object.fromEntries(HEALTHS.map((h) => [h, scope.filter((p) => p.health === h).length])) as Record<Health, number>;
  const avgProgress = scope.length ? Math.round(scope.reduce((s, p) => s + p.progress, 0) / scope.length) : 0;
  // Where the projects should be by today, on average: the share of each one's window already gone.
  const started = scope.filter((p) => p.startDate <= today);
  const timeGone = started.length ? Math.round(started.reduce((s, p) => s + expectedProgress(p.startDate, p.endDate, today), 0) / started.length) : 0;
  const soon = scope
    .flatMap((p) => p.milestones.filter((m) => !m.done && m.date >= today && diffDays(today, m.date) <= 14).map((m) => ({ m, p })))
    .sort((a, b) => a.m.date.localeCompare(b.m.date));
  const thisWeek = weekStart(today);
  const running = scope.filter((p) => p.startDate <= today && p.health !== 'done');
  const filed = running.filter((p) => p.lastUpdateWeek === thisWeek).length;

  return (
    <>
      {head}

      <section className="verdict enter" style={stagger(1)} aria-label={t('health')}>
        <div className="spotlight" onPointerMove={spotlight}>
          <p className="verdict-head">
            {(() => {
              const [a, b] = t('onTrackOf', { n: '\u0000', total: scope.length - counts.done }).split('\u0000');
              return (
                <>
                  {a}
                  <CountUp value={counts.on_track} className="num" />
                  {b}
                </>
              );
            })()}
          </p>
          <div className="health-strip" role="img" aria-label={HEALTHS.map((h) => `${t(`health_${h}`)} ${counts[h]}`).join(', ')}>
            {(['on_track', 'done', 'at_risk', 'off_track', 'not_started'] as Health[])
              .filter((h) => counts[h] > 0)
              .map((h, i) => (
                <span key={h} style={stagger(i, { flex: counts[h], background: HEALTH_COLOR[h] })} />
              ))}
          </div>
          <div className="strip-legend">
            {(['on_track', 'at_risk', 'off_track', 'not_started', 'done'] as Health[])
              .filter((h) => counts[h] > 0)
              .map((h) => (
                <button
                  key={h}
                  className={`chip h-${h}`}
                  aria-pressed={healthFilter === h}
                  onClick={() => setHealthFilter(healthFilter === h ? null : h)}
                  style={{ height: 24, padding: '0 8px', fontSize: 12.5 }}
                >
                  <HealthBadge health={h} />
                  <span className="num" style={{ color: 'var(--ink)' }}>{counts[h]}</span>
                </button>
              ))}
          </div>
        </div>
        <div className="spotlight" onPointerMove={spotlight}>
          <div className="figure num">
            <CountUp value={avgProgress} />
            <small>%</small>
          </div>
          <div className="figure-label">{t('avgProgress')}</div>
          <div style={{ marginTop: 10 }}>
            <Meter value={avgProgress} expected={timeGone} />
          </div>
          <div className="figure-note">{t('vsExpected', { n: timeGone })}</div>
        </div>
        <div className="spotlight" onPointerMove={spotlight}>
          <div className="figure num">
            <CountUp value={soon.length} />
          </div>
          <div className="figure-label">{t('milestonesSoon')}</div>
          {soon[0] && (
            <div className="figure-note" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {fmtDate(soon[0].m.date, lang)}: {soon[0].m.name}
            </div>
          )}
        </div>
        <div className="spotlight" onPointerMove={spotlight}>
          <div className="figure num">
            <CountUp value={filed} />
            <small>/{running.length}</small>
          </div>
          <div className="figure-label">{t('updatesIn')}</div>
          <a className="figure-note" href="#/updates" style={{ display: 'inline-block' }}>
            {t('weekOf', { d: fmtDate(thisWeek, lang) })}
          </a>
        </div>
      </section>

      {level.kind === 'root' && unlinked.length > 0 && (
        <div className="plan-unlinked enter" style={stagger(2)} role="note">
          <span>{t('planUnlinkedNote', { n: unlinked.length })}</span>
          <button className="chip" aria-pressed={unlinkedOnly} onClick={() => setUnlinkedOnly(!unlinkedOnly)}>
            {t('planShowUnlinked')}
          </button>
          {can('projects.edit_all') && (
            <button className="btn btn-sm btn-primary" onClick={() => setLinking(true)}>
              <LinkSimple size={15} aria-hidden /> {t('planLinkProjects')}
            </button>
          )}
        </div>
      )}
      {level.kind === 'root' && unlinked.length === 0 && can('projects.edit_all') && (
        <div style={{ textAlign: 'end', marginBottom: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setLinking(true)}>
            <LinkSimple size={15} aria-hidden /> {t('planLinkProjects')}
          </button>
        </div>
      )}
      {(level.kind === 'root' || level.kind === 'capability') && <GroupGrid plan={plan} level={level} byId={byId} query={query} />}
      {level.kind === 'dimension' && where.dimension && <InitiativeList inits={where.dimension.initiatives} byId={byId} query={query} />}
      {level.kind === 'initiative' && where.initiative && <InitiativeDetail it={where.initiative} byId={byId} projects={data} onLinked={reloadAll} />}

      <h2 className="plan-section">{t('planProjectsHere', { n: scope.length })}</h2>
      <div className="filters enter" style={stagger(2)}>
        <div className="search">
          <MagnifyingGlass size={16} aria-hidden />
          <input className="input" type="search" placeholder={t('search')} aria-label={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="chip" aria-pressed={deptFilter === null} onClick={() => setDeptFilter(null)}>
          {t('allDepartments')}
        </button>
        {meta.departments
          .filter((d) => scope.some((p) => p.departmentId === d.id))
          .map((d) => (
            <button key={d.id} className="chip" aria-pressed={deptFilter === d.id} onClick={() => setDeptFilter(deptFilter === d.id ? null : d.id)}>
              <span className="swatch" style={{ background: deptColor(d.colorSlot) }} />
              {deptName(d, lang)}
            </button>
          ))}
        <div style={{ marginInlineStart: 'auto' }}>
          <Segmented
            label={t('routeMap')}
            value={view}
            onChange={changeView}
            options={[
              { value: 'map', label: (<><Path size={15} aria-hidden />{t('routeMap')}</>) },
              { value: 'list', label: (<><Rows size={15} aria-hidden />{t('list')}</>) },
            ]}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="panel">
          <Empty
            title={t('noMatchTitle')}
            action={
              <button
                className="btn"
                onClick={() => {
                  setDeptFilter(null);
                  setHealthFilter(null);
                  setQuery('');
                  setUnlinkedOnly(false);
                }}
              >
                {t('clearFilters')}
              </button>
            }
          />
        </div>
      ) : view === 'map' ? (
        <>
          <div style={{ marginBottom: 10 }}>
            <RouteLegend />
          </div>
          <RouteMap
            projects={filtered}
            departments={meta.departments}
            users={usersById}
            quarter={window}
            today={today}
            onOpen={(id) => navigate(`/projects/${id}/plan`)}
          />
        </>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('project')}</th>
                <th>{t('manager')}</th>
                <th>{t('stage')}</th>
                <th>{t('health')}</th>
                <th style={{ width: 160 }}>{t('progress')}</th>
                <th>{t('finish')}</th>
                <th>{t('nextMilestone')}</th>
                <th>{t('lastUpdate')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const d = dept(p.departmentId);
                const next = p.milestones.find((m) => !m.done);
                const slip = p.baselineEnd ? diffDays(p.baselineEnd, p.endDate) : 0;
                const exp = expectedProgress(p.startDate, p.endDate, today);
                return (
                  <tr key={p.id} className="clickable enter" style={stagger(i)} onClick={() => navigate(`/projects/${p.id}/plan`)}>
                    <td>
                      <a href={`#/projects/${p.id}/plan`} className="cell-project" style={{ textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
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
                    <td className="ink-2">{t(`stage_${p.stage}`)}</td>
                    <td>
                      <HealthBadge health={p.health} />
                    </td>
                    <td>
                      <div style={{ display: 'grid', gridTemplateColumns: '36px 1fr', alignItems: 'center', gap: 8 }}>
                        <span className="num">{p.progress}%</span>
                        <Meter value={p.progress} expected={p.startDate <= today ? exp : undefined} />
                      </div>
                    </td>
                    <td className="num">
                      {fmtDate(p.endDate, lang)}
                      {slip > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--bad)' }}>+{slip}d</div>
                      )}
                    </td>
                    <td>
                      {next ? (
                        <>
                          <div style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{next.name}</div>
                          <div className="code" style={{ color: next.date < today ? 'var(--bad)' : undefined }}>{fmtDate(next.date, lang)}</div>
                        </>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td className={p.lastUpdateWeek === thisWeek ? '' : 'muted'}>
                      {p.lastUpdateWeek ? t('weekOf', { d: fmtDate(p.lastUpdateWeek, lang) }) : t('noUpdate')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {dialog}
      {chatDialog}
      {askDialog}
      {linkDialog}
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
        {filtered.length} {t('projects')}
      </p>
    </>
  );
}
