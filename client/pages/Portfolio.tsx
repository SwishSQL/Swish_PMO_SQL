import { useEffect, useMemo, useRef, useState } from 'react';
import { ALL_DATES, DateRange, inRange, overlaps } from '../components/DateRange';
import type { Range } from '../components/DateRange';
import { ChatCircleText, FileXls, LinkSimple, MagnifyingGlass, Plus, Path, Rows, Sparkle } from '@phosphor-icons/react';
import type { Capability, Health, MilestoneRow, ProjectSummary, Quarter } from '../../shared/types';
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
import { HomeSummary } from '../components/HomeSummary';
import { CATEGORY_PREVIEW_USERS, CategoryCards, MyMilestonesCell, categorySets } from '../components/CategoryCards';
import type { Category } from '../components/CategoryCards';
import { AddProgramButton, PlanManagerCard } from '../components/PlanManagers';
import { MyIndicator } from './Insights';
import { LearnMore } from '../components/Tour';

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
  const [dates, setDates] = useState<Range>(ALL_DATES);
  const [creating, setCreating] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  // The home page has two tabs. Each person's last choice is kept; the first time, those who oversee the whole
  // portfolio (PMO, executives) start on the transformation plan and everyone else on their projects.
  const [tab, setTab] = useState<'projects' | 'plan'>(() => {
    const saved = safeGet('pmo.homeTab');
    if (saved === 'projects' || saved === 'plan') return saved;
    return can('projects.edit_all') || can('projects.view_all') ? 'plan' : 'projects';
  });
  const changeTab = (v: 'projects' | 'plan') => {
    setTab(v);
    safeSet('pmo.homeTab', v);
  };
  const [newMenu, setNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newMenu) return;
    const away = (e: MouseEvent) => !newMenuRef.current?.contains(e.target as Node) && setNewMenu(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setNewMenu(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [newMenu]);
  // The assistant needs an API key on the server: without one its button is not shown.
  const ai = useLoad(() => api.get<{ enabled: boolean; variables?: string[] }>('/api/ai/status'), [], 'ai-status');
  const { data, error, reload } = useLoad(() => api.get<ProjectSummary[]>('/api/projects?quarter='), [], 'projects-all');
  const planLoad = useLoad(() => api.get<Capability[]>('/api/transformation'), [], 'plan');
  // The milestones behind the summary: whose they are, and which are required.
  const msLoad = useLoad(() => api.get<MilestoneRow[]>('/api/milestones'), [], 'milestones');
  // Which projects the list shows: open ones unless asked otherwise, and for those who run projects, theirs.
  // Both choices are kept for next time.
  const [status, setStatusState] = useState<'open' | 'closed' | 'all'>(() => {
    const v = safeGet('pmo.status');
    return v === 'closed' || v === 'all' ? v : 'open';
  });
  const setStatus = (v: 'open' | 'closed' | 'all') => {
    setStatusState(v);
    safeSet('pmo.status', v);
  };
  const [whose, setWhoseState] = useState<'mine' | 'all'>(() => (safeGet('pmo.whose') === 'all' ? 'all' : 'mine'));
  const setWhose = (v: 'mine' | 'all') => {
    setWhoseState(v);
    safeSet('pmo.whose', v);
  };
  const headOf = useMemo(() => new Set(meta.departments.filter((d) => d.headUserId === meta.me.id).map((d) => d.id)), [meta.departments, meta.me.id]);
  const runs = (p: ProjectSummary) => p.managerId === meta.me.id || headOf.has(p.departmentId);
  const overview = can('projects.edit_all') || can('projects.view_all') || meta.managesPlan;
  // "Mine | All" is offered to those who run projects and do not oversee the whole portfolio.
  const runsAny = !overview && (data ?? []).some(runs);
  // Offered only when it changes the list: they also see projects they work on without running them.
  const offerMine = runsAny && (data ?? []).some((p) => !runs(p));
  // A team member (runs no project, oversees nothing) sees only the projects they work on: no transformation plan.
  const teamMember = !overview && !runsAny;
  // The transformation plan is for the system admins, the PMO and the department heads; everyone else sees projects.
  // A project manager sees the plan too: the plan projects not started yet, each with its Start project button.
  const seesPlan = meta.canManageUsers || can('projects.edit_all') || headOf.size > 0 || meta.managesPlan || can('projects.start_plan');
  const mineOnly = offerMine && whose === 'mine';
  // "I manage": only the projects this person is the project manager of. Offered when they also see others.
  const managesAny = (data ?? []).some((p) => p.managerId === meta.me.id);
  const offerManaged = managesAny && (data ?? []).some((p) => p.managerId !== meta.me.id);
  const [managedPick, setManagedPick] = useState(() => safeGet('pmo.iManage') === '1');
  // The category cards (being tried with one person first) replace the I manage button for them.
  const preview = CATEGORY_PREVIEW_USERS.has(meta.me.id);
  const managedOnly = !preview && offerManaged && managedPick;
  const [category, setCategoryState] = useState<Category>(() => (safeGet('pmo.category') as Category) || 'all');
  const setCategory = (c: Category) => {
    setCategoryState(c);
    safeSet('pmo.category', c);
  };
  const toggleManaged = () => {
    setManagedPick(!managedPick);
    safeSet('pmo.iManage', managedPick ? '0' : '1');
  };
  const plan = planLoad.data ?? [];
  const level = parseLevel(seesPlan ? path : []);
  const where = locate(plan, level);
  const byId = useMemo(() => new Map((data ?? []).map((p) => [p.id, p])), [data]);
  // The projects in reach: all of them at the top, else those under the capability, dimension or plan project.
  const sets = useMemo(
    () => categorySets(data ?? [], plan, msLoad.data ?? null, meta.me.id, headOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, plan, msLoad.data, meta.me.id, headOf],
  );
  const activeCategory: Category = preview && category !== 'all' && sets[category].size > 0 ? category : 'all';
  // With My milestones picked, the list shows this person's milestones in each project instead of the schedule columns.
  const msMode = activeCategory === 'ms';
  const myMs = useMemo(() => {
    const by = new Map<number, MilestoneRow[]>();
    for (const m of msLoad.data ?? []) if (m.mine && !m.notRequired && m.status !== 'cancelled') by.set(m.projectId, [...(by.get(m.projectId) ?? []), m]);
    return by;
  }, [msLoad.data]);
  const scope = useMemo(
    () => {
      const base = level.kind === 'root' ? data ?? [] : projectsOf(initiativesAt(plan, level), byId);
      return activeCategory === 'all' ? base : base.filter((p) => sets[activeCategory].has(p.id));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, plan, path.join('/'), activeCategory, sets],
  );
  const unlinked = (data ?? []).filter((p) => !p.initiativeId);
  const today = meta.today;
  // The route map's window: two months back, four ahead.
  const window: Quarter = { id: 0, code: '', year: 0, q: 0, startsOn: `${addDays(today, -60).slice(0, 8)}01`, endsOn: addDays(`${addDays(today, 125).slice(0, 8)}01`, -1) };
  const usersById = useMemo(() => new Map(meta.users.map((u) => [u.id, u])), [meta.users]);

  // Search finds a project by anything shown about it: code, name, owner, sponsor, department, stage, health or a milestone.
  const haystack = (p: (typeof scope)[number]) =>
    [
      p.code, p.name, p.nameAr, p.managerName, p.sponsor,
      meta.departments.find((d) => d.id === p.departmentId)?.name,
      t(`stage_${p.stage}`), t(`health_${p.health}`),
      ...p.milestones.map((m) => m.name),
    ]
      .filter(Boolean)
      .join(' | ')
      .toLowerCase();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scope.filter(
      (p) =>
        (!unlinkedOnly || !p.initiativeId) &&
        (!deptFilter || p.departmentId === deptFilter) &&
        (!healthFilter || p.health === healthFilter) &&
        (status === 'all' || (status === 'open') === (p.health !== 'done')) &&
        (!mineOnly || runs(p)) &&
        (!managedOnly || p.managerId === meta.me.id) &&
        overlaps(p.startDate, p.endDate, dates) &&
        (!q || haystack(p).includes(q)),
    );
  }, [scope, deptFilter, healthFilter, status, mineOnly, managedOnly, headOf, query, unlinkedOnly, dates]);

  const changeView = (v: 'map' | 'list') => {
    setView(v);
    safeSet('pmo.view', v);
  };

  // A project manager has no New project: they start a project from its plan project, on the Plan tab.
  const canCreate = meta.departments.some((d) => canCreateIn(d.id));

  const head = (
    <div className="page-head">
      <div>
        {level.kind !== 'root' && <Trail plan={plan} level={level} />}
        <h1 className="page-title">{where.initiative?.name ?? where.dimension?.name ?? where.capability?.name ?? (teamMember ? t('myProjectsTitle') : t('portfolio'))}</h1>
        <LearnMore page="home" />
        <p className="page-sub">
          {level.kind === 'root' && !seesPlan
            ? t('myProjectsSub', { n: (data ?? []).length })
            : level.kind === 'root'
            ? t('planRootSub', { c: plan.length, p: plan.reduce((n, c) => n + c.dimensions.reduce((m, d) => m + d.initiatives.length, 0), 0) })
            : t('planScopeSub', { n: scope.length })}
        </p>
        {level.kind === 'root' && <MyIndicator />}
        {level.kind === 'capability' && where.capability && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <PlanManagerCard kind="capability" id={where.capability.id} userId={where.capability.managerUserId} onChanged={planLoad.reload} />
            <AddProgramButton capabilityId={where.capability.id} capabilityName={where.capability.name} onAdded={planLoad.reload} />
          </div>
        )}
        {level.kind === 'dimension' && where.dimension && (
          <PlanManagerCard kind="dimension" id={where.dimension.id} userId={where.dimension.managerUserId} onChanged={planLoad.reload} />
        )}
        {ai.data && !ai.data.enabled && can('projects.edit_all') && (
          <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }} role="status">
            {t('aiOff', { v: ai.data.variables?.length ? ai.data.variables.join(', ') : t('aiOffNone') })}
          </p>
        )}
      </div>
      <div className="toolbar">
        {/* The quarter on screen, or every project as the old tracker's export gave it. */}
        {!teamMember && (
        <div className="export-menu">
          <ExportButton url="/api/export/portfolio.xlsx?quarter=all">
            <FileXls size={16} aria-hidden />
            <span title={t('exportExcel')}>{t('exportShort')}</span>
          </ExportButton>
        </div>
        )}
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
          <button className="btn" onClick={() => setAsking(true)} title={t('askPortfolio')}>
            <ChatCircleText size={16} weight="fill" aria-hidden />
            {t('askShort')}
          </button>
        )}
        {canCreate && (
          <div className="new-menu-wrap" ref={newMenuRef}>
            <button
              className="btn btn-primary"
              onClick={() => (ai.data?.enabled ? setNewMenu((o) => !o) : setCreating(true))}
              aria-haspopup={ai.data?.enabled ? 'menu' : undefined}
              aria-expanded={ai.data?.enabled ? newMenu : undefined}
            >
              <Plus size={16} weight="bold" aria-hidden />
              {t('newProject')}
            </button>
            {newMenu && (
              <div className="new-menu" role="menu">
                <button role="menuitem" onClick={() => (setNewMenu(false), setChatting(true))}>
                  <Sparkle size={16} weight="fill" aria-hidden />
                  {t('aiCreate')}
                </button>
                <button role="menuitem" onClick={() => (setNewMenu(false), setCreating(true))}>
                  <Plus size={16} aria-hidden />
                  {t('createByHand')}
                </button>
              </div>
            )}
          </div>
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

  const atRoot = level.kind === 'root';
  // Team members have no plan tab: their page is their projects.
  const showPlan = !atRoot || (tab === 'plan' && seesPlan);
  const showProjects = !atRoot || tab === 'projects' || !seesPlan;
  const planCount = plan.reduce((n, c) => n + c.dimensions.reduce((m, d) => m + d.initiatives.length, 0), 0);
  const active = scope.length - counts.done;

  return (
    <>
      {head}

      {preview && atRoot && <CategoryCards data={data} sets={sets} milestones={msLoad.data ?? null} value={activeCategory} onChange={setCategory} />}

      <HomeSummary
        merged={preview}
        scope={scope}
        milestones={msLoad.data ?? null}
        healthFilter={healthFilter}
        onHealth={(h) => {
          setHealthFilter(h);
          if (atRoot && h) changeTab('projects');
        }}
        openFilter={status === 'all' ? null : status}
        onOpenFilter={(v) => {
          setStatus(v ?? 'all');
          if (atRoot && v) changeTab('projects');
        }}
      />

      {atRoot && !seesPlan && (
        <div className="home-tabs enter" style={stagger(2)}>
          <h2 className="home-tabs-title">
            {t('tabProjects')}{' '}
            <span className="num">{filtered.length === scope.length ? scope.length : t('nOfTotal', { n: filtered.length, total: scope.length })}</span>
          </h2>
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
      )}
      {atRoot && seesPlan && (
        <div className="home-tabs enter" style={stagger(2)}>
          <div role="tablist" aria-label={t('portfolio')}>
            <button role="tab" aria-selected={tab === 'projects'} onClick={() => changeTab('projects')}>
              {t('tabProjects')}{' '}
              <span className="num">{filtered.length === scope.length ? scope.length : t('nOfTotal', { n: filtered.length, total: scope.length })}</span>
            </button>
            <button role="tab" aria-selected={tab === 'plan'} onClick={() => changeTab('plan')}>
              {t('tabPlan')} <span className="num">{planCount}</span>
            </button>
          </div>
          {tab === 'projects' && <Segmented
            label={t('routeMap')}
            value={view}
            onChange={changeView}
            options={[
              { value: 'map', label: (<><Path size={15} aria-hidden />{t('routeMap')}</>) },
              { value: 'list', label: (<><Rows size={15} aria-hidden />{t('list')}</>) },
            ]}
          />}
        </div>
      )}

      {/* Only the PMO links projects to the plan, so only the PMO is told which are not linked. */}
      {showPlan && atRoot && unlinked.length > 0 && can('projects.edit_all') && (
        <div className="plan-unlinked enter" style={stagger(2)} role="note">
          <span>{t('planUnlinkedNote', { n: unlinked.length })}</span>
          <button
            className="chip"
            aria-pressed={unlinkedOnly}
            onClick={() => {
              setUnlinkedOnly(true);
              changeTab('projects');
            }}
          >
            {t('planShowUnlinked')}
          </button>
          {can('projects.edit_all') && (
            <button className="btn btn-sm btn-primary" onClick={() => setLinking(true)}>
              <LinkSimple size={15} aria-hidden /> {t('planLinkProjects')}
            </button>
          )}
        </div>
      )}
      {showPlan && atRoot && unlinked.length === 0 && can('projects.edit_all') && (
        <div style={{ textAlign: 'end', marginBottom: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setLinking(true)}>
            <LinkSimple size={15} aria-hidden /> {t('planLinkProjects')}
          </button>
        </div>
      )}
      {showPlan && (level.kind === 'root' || level.kind === 'capability') && <GroupGrid plan={plan} level={level} byId={byId} query={query} />}
      {level.kind === 'dimension' && where.dimension && <InitiativeList inits={where.dimension.initiatives} byId={byId} query={query} />}
      {level.kind === 'initiative' && where.initiative && <InitiativeDetail it={where.initiative} byId={byId} projects={data} onLinked={reloadAll} />}

      {showProjects && (
      <>
      {!atRoot && <h2 className="plan-section">{t('planProjectsHere', { n: scope.length })}</h2>}
      <div className="filters enter" style={stagger(2)}>
        <Segmented
          label={t('pf_status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: t('pf_open') },
            { value: 'closed', label: t('pf_closed') },
            { value: 'all', label: t('pf_all') },
          ]}
        />
        {!preview && offerManaged && (
          <button className="chip" aria-pressed={managedOnly} onClick={toggleManaged} title={t('pf_iManageHint')}>
            {t('pf_iManage')} <span className="num">{scope.filter((p) => p.managerId === meta.me.id && (status === 'all' || (status === 'open') === (p.health !== 'done'))).length}</span>
          </button>
        )}
        {offerMine && (
          <Segmented
            label={t('pf_whose')}
            value={whose}
            onChange={setWhose}
            options={[
              { value: 'mine', label: t('pf_mine') },
              { value: 'all', label: t('pf_everyone') },
            ]}
          />
        )}
        <div className="search">
          <MagnifyingGlass size={16} aria-hidden />
          <input className="input" type="search" placeholder={t('searchAnything')} aria-label={t('searchAnything')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <DateRange value={dates} onChange={setDates} today={meta.today} />
        <span className="filters-break" aria-hidden />
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
        {(unlinkedOnly || healthFilter) && (
          <button className="chip" aria-pressed onClick={() => (setUnlinkedOnly(false), setHealthFilter(null))}>
            {unlinkedOnly ? t('planShowUnlinked') : t(`health_${healthFilter as Health}`)} ×
          </button>
        )}
        {!atRoot && (
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
        )}
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
                  setStatus('all');
                  setWhose('all');
                }}
              >
                {t('clearFilters')}
              </button>
            }
          />
        </div>
      ) : view === 'map' && activeCategory !== 'ms' ? (
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
                {msMode && <th>{t('cat_ms')}</th>}
                {!msMode && <th>{t('stage')}</th>}
                <th>{t('health')}</th>
                <th style={{ width: 160 }}>{t('progress')}</th>
                {!msMode && <th>{t('finish')}</th>}
                {!msMode && <th>{t('nextMilestone')}</th>}
                {!msMode && <th>{t('lastUpdate')}</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const d = dept(p.departmentId);
                const next = p.milestones.find((m) => !m.done);
                const slip = p.baselineSlip ?? 0;
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
                        {(p.blockedBy?.length ?? 0) > 0 && (
                          <span className="flag-chip warn" title={t('dep_blockedBy', { codes: p.blockedBy!.map((b) => b.code).join(', ') })}>
                            {t('dep_blocked')}
                          </span>
                        )}
                      </a>
                    </td>
                    <td>
                      <Person user={user(p.managerId)} name={p.managerName} />
                    </td>
                    {msMode && (
                      <td style={{ minWidth: 280 }}>
                        <MyMilestonesCell items={myMs.get(p.id) ?? []} />
                      </td>
                    )}
                    {!msMode && <td className="ink-2">{t(`stage_${p.stage}`)}</td>}
                    <td>
                      <HealthBadge health={p.health} />
                    </td>
                    <td>
                      <div style={{ display: 'grid', gridTemplateColumns: '36px 1fr', alignItems: 'center', gap: 8 }}>
                        <span className="num">{p.progress}%</span>
                        <Meter value={p.progress} expected={p.startDate <= today ? exp : undefined} />
                      </div>
                    </td>
                    {!msMode && (<>
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
                    </>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
        {filtered.length} {t('projects')}
      </p>
      </>
      )}
      {dialog}
      {chatDialog}
      {askDialog}
      {linkDialog}
    </>
  );
}
