import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TEAM_ROLES } from '../../shared/types';
import { teamRoleLabel } from '../lib/format';
import { AllDoneDialog, ClosureDocsPanel, openMilestonesOf } from '../components/ClosureDocs';
import { CaretRight, FileXls, PencilSimple, Plus, Trash, Archive, WarningCircle, CalendarCheck } from '@phosphor-icons/react';
import type {
  Health,
  Level,
  Priority,
  ProjectDetail,
  Risk,
  RiskKind,
  MeetingNote,
  RiskStatus,
  Stage,
  StatusUpdate,
  Task,
} from '../../shared/types';
import { HEALTHS, PRIORITIES, STAGES } from '../../shared/types';
import { addDays, diffDays, weekStart } from '../../shared/dates';
import { criticalPath, expectedProgress } from '../../shared/schedule';
import { api } from '../api';
import { navigate, useApp, useLoad, useToast } from '../lib/app';
import { confirmLeave } from '../lib/unsaved';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { deptName, fmtDate, fmtDateTime, fmtNumber, projectName } from '../lib/format';
import { motion } from 'motion/react';
import { SPRING, stagger } from '../lib/motion';
import { Gantt } from '../components/Gantt';
import type { PlanState } from '../components/Gantt';
import { TaskPanel } from '../components/TaskPanel';
import { ConfirmDone } from '../components/ConfirmDone';
import { STAGE_FIELDS } from '../../shared/stageRequirements';
import { DeleteProject } from '../components/DeleteProject';
import { ReasonDialog } from '../components/ReasonDialog';
import { UpdateDialog } from '../components/UpdateDialog';
import { DeliveryDoc, readDeliveryFile } from '../components/DeliveryDoc';
import { ChangesTab } from '../components/ChangesTab';
import {
  deptColor,
  Dialog,
  Empty,
  ErrorState,
  ExportButton,
  Field,
  HealthBadge,
  HealthIcon,
  Meter,
  PageSkeleton,
  Person,
  useLatest,
} from '../components/ui';
import { DateInput } from '../components/DateInput';
import { SponsorSelect } from '../components/SponsorSelect';
import { PeoplePicker } from '../components/PeoplePicker';
import { DependsBar, DependsOnEditor } from '../components/ProjectDeps';
import { MentionTextarea } from '../components/MentionTextarea';
import { AiPmBar } from '../components/AiPm';
import { LearnMore } from '../components/Tour';

type Plan = PlanState & { project: { startDate: string; endDate: string; progress: number } };

const TABS = ['plan', 'updates', 'meetings', 'risks', 'changes', 'team', 'details', 'activity'] as const;

export function ProjectPage({ id, tab }: { id: number; tab: string }) {
  const { meta, dept, user, can, canEditProject, canGovernProject } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const { data, setData, error, reload } = useLoad(() => api.get<ProjectDetail>(`/api/projects/${id}`), [id], 'project');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [writing, setWriting] = useState(false);
  const [rebaselining, setRebaselining] = useState(false);
  const [asking, setAsking] = useState<{ name: string; from: string; to: string; resolve: (reason: string | null) => void } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState<{ name: string; reopen: boolean; askNote: boolean; resolve: (note: string | null) => void } | null>(null);

  const applyPlan = useCallback(
    (plan: Plan) =>
      setData((d) =>
        d
          ? {
              ...d,
              tasks: plan.tasks,
              dependencies: plan.dependencies,
              project: { ...d.project, ...plan.project },
            }
          : d,
      ),
    [setData],
  );

  const run = useCallback(
    async (p: Promise<Plan>) => {
      try {
        const plan = await p;
        applyPlan(plan);
        return plan;
      } catch (e) {
        toast((e as Error).message, 'bad');
        return null;
      }
    },
    [applyPlan, toast],
  );

  const usersById = useMemo(() => new Map(meta.users.map((u) => [u.id, u])), [meta.users]);

  // Arriving with ?task=ID (from the Milestones page or a notification): open that milestone's panel.
  // Also while already on this project, when a notification points at another of its milestones.
  const loadedId = data?.project.id;
  const tasksRef = useLatest(data?.tasks);
  const canOpenRef = useRef<((x: Task) => boolean) | null>(null);
  // Arriving from "Needs your action" to approve the plan's dates: a banner says what to do.
  const [guideBaseline, setGuideBaseline] = useState(() => /[?&]do=baseline/.test(window.location.hash));
  useEffect(() => {
    if (/[?&]do=baseline/.test(window.location.hash)) window.history.replaceState(null, '', window.location.hash.replace(/[?&]do=baseline/, ''));
  }, []);
  const prevOpenRef = useRef<number | null>(null);
  const [allDone, setAllDone] = useState(false);
  useEffect(() => {
    if (!loadedId) return;
    const openFromHash = (arriving: boolean) => {
      const m = window.location.hash.match(/[?&]task=(\d+)/);
      if (!m) return;
      const taskId = Number(m[1]);
      const found = tasksRef.current?.find((x) => x.id === taskId);
      const mine = Boolean(found);
      // Everyone sees the whole plan; a team member opens only what is theirs.
      if (found && (canOpenRef.current?.(found) ?? true)) {
        setSelectedId(taskId);
        setPanelOpen(true);
      }
      // A link to another project's milestone passes through this page on its way: leave it for that page.
      if (mine || arriving) window.history.replaceState(null, '', window.location.hash.replace(/[?&]task=\d+/, ''));
    };
    const onHash = () => openFromHash(false);
    openFromHash(true);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [loadedId, tasksRef]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;

  const { project, tasks, dependencies } = data;
  const me = meta.me;
  void me;
  const canEdit = canEditProject(
    project.managerId,
    data.members.map((m) => m.userId),
    project.departmentId,
  );
  // Same rules as the server: the manager or the PMO decide about the project itself,
  // including its health and the weekly update that sets it.
  const canGovern = canGovernProject(project.managerId, project.departmentId);
  // The moment the last milestone is done (in this visit), closing is next: say so, with the documents it needs.
  const openNow = openMilestonesOf(data);
  const closedNow = project.health === 'done' || data.closure?.status === 'pending';
  if (prevOpenRef.current !== null && prevOpenRef.current > 0 && openNow === 0 && !closedNow && canGovern && !allDone) {
    prevOpenRef.current = openNow;
    queueMicrotask(() => setAllDone(true));
  } else prevOpenRef.current = openNow;
  canOpenRef.current = (x: Task) => canGovern || !can('projects.edit_own') || isMine(x, me) || Boolean(x.systemKey);
  // Closing is decided by a PMO admin: others ask. Same rule as the server.
  const canClose = can('projects.approve_close');
  const canWriteUpdate = canGovern && (can('updates.write') || can('projects.edit_all'));
  // Milestones and tasks waiting for approved dates (the closure documents milestone follows the plan's end).
  const datesToApprove = tasks.filter((x) => x.kind !== 'summary' && !x.systemKey && !x.baselineEnd && x.status !== 'cancelled').length;
  const approveDates = async () => {
    try {
      setData(await api.post<ProjectDetail>(`/api/projects/${id}/baseline`, { mode: 'missing' }));
      setGuideBaseline(false);
      toast(t('baselineSet'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const baselineMode: 'all' | 'missing' | null = can('projects.edit_all') ? 'all' : canGovern && datesToApprove > 0 ? 'missing' : null;
  // Planning (adding, removing, ordering, linking) is the owner's, the department head's and the PMO's.
  // After the baseline a milestone (or a phase holding one) is removed only by a change request.
  const baselined = Boolean(project.baselineEnd);
  const holdsMilestone = (x: Task): boolean => x.kind === 'milestone' || tasks.some((c) => c.parentId === x.id && holdsMilestone(c));
  const canDeleteTask = (x: Task) => canGovern && !x.systemKey && !(baselined && holdsMilestone(x));
  const d = dept(project.departmentId);
  const color = deptColor(d?.colorSlot);
  const today = meta.today;
  const expected = expectedProgress(project.startDate, project.endDate, today);
  // Read from the items that have a baseline; none yet (all added since) says so rather than a stale gap.
  const slip = project.baselineEnd ? project.baselineSlip : null;
  const thisWeek = weekStart(today);
  // A team member (does not run the project, does not oversee the portfolio) works from the plan, meetings, risks,
  // team and details. The weekly report, change requests and the log are the manager's and the PMO's.
  const memberView = !canGovern && !can('projects.view_all') && !can('projects.edit_all');
  const tabs = memberView ? TABS.filter((k) => k !== 'updates' && k !== 'changes' && k !== 'activity') : TABS;
  const currentTab = (tabs as readonly string[]).includes(tab) ? tab : 'plan';

  const patchProject = async (body: Record<string, unknown>) => {
    try {
      setData(await api.patch<ProjectDetail>(`/api/projects/${id}`, body));
      toast(t('saved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  // ---- Plan commands ----
  const selected = tasks.find((x) => x.id === selectedId) ?? null;
  const ordered = [...tasks].sort((a, b) => a.sort - b.sort || a.id - b.id);
  const lastInSubtree = (rootId: number): number => {
    const ids = new Set([rootId]);
    let last = rootId;
    for (const tk of ordered) {
      if (tk.parentId && ids.has(tk.parentId)) {
        ids.add(tk.id);
        last = tk.id;
      }
    }
    return last;
  };

  const addTask = async (kind: 'summary' | 'task' | 'milestone') => {
    let parentId: number | null = null;
    let afterId: number | null = null;
    let start = project.startDate;
    if (kind === 'summary') {
      const lastEnd = tasks.reduce((m, x) => (x.endDate > m ? x.endDate : m), '');
      start = lastEnd ? addDays(lastEnd, 1) : project.startDate;
    } else if (kind === 'task') {
      // A task goes inside a milestone: the selected one, or the one the selected task is in.
      const milestone = selected?.kind === 'milestone' ? selected : selected?.kind === 'task' ? tasks.find((x) => x.id === selected.parentId && x.kind === 'milestone') : undefined;
      if (!milestone) {
        toast(t('taskNeedsMilestone'), 'bad');
        return;
      }
      parentId = milestone.id;
      afterId = selected!.kind === 'task' ? selected!.id : lastInSubtree(milestone.id);
      // The work leads up to the milestone: it ends on the milestone's date.
      start = addDays(milestone.endDate, -4) < project.startDate ? project.startDate : addDays(milestone.endDate, -4);
    } else if (selected) {
      // A milestone goes inside the selected phase, or next to the selected milestone (or the one a task is in).
      const anchor = selected.kind === 'task' ? (tasks.find((x) => x.id === selected.parentId) ?? selected) : selected;
      if (anchor.kind === 'summary') {
        parentId = anchor.id;
        afterId = lastInSubtree(anchor.id);
        start = anchor.startDate;
      } else {
        parentId = anchor.parentId;
        afterId = lastInSubtree(anchor.id);
        start = addDays(anchor.endDate, 1);
      }
    }
    const name = kind === 'summary' ? t('kind_summary') : kind === 'milestone' ? t('kind_milestone') : t('kind_task');
    const before = new Set(tasks.map((x) => x.id));
    const plan = await run(
      api.post<Plan>(`/api/projects/${id}/tasks`, {
        kind,
        name,
        parentId,
        afterId,
        startDate: start,
        endDate: kind === 'milestone' ? start : kind === 'task' && parentId ? (tasks.find((x) => x.id === parentId)?.endDate ?? addDays(start, 4)) : addDays(start, kind === 'summary' ? 13 : 4),
      }),
    );
    const created = plan?.tasks.find((x) => !before.has(x.id));
    if (created) {
      setSelectedId(created.id);
      setEditingId(created.id);
    }
  };

  // A milestone's deadline is a commitment: moving it asks for a reason first (a dialog), and a
  // cancelled dialog leaves the date where it was.
  const patchTask = async (taskId: number, patch: Partial<Task>) => {
    const tk = data?.tasks.find((x) => x.id === taskId);
    const body: Record<string, unknown> = { ...patch };
    // Completing a milestone, or reopening a done one, asks first; completing can add a note.
    const completes = tk?.kind === 'milestone' && patch.status === 'done' && tk.status !== 'done';
    const reopens = tk?.kind === 'milestone' && tk.status === 'done' && patch.status !== undefined && patch.status !== 'done';
    if (tk && (completes || reopens)) {
      const given = (patch as { updateComment?: string }).updateComment;
      const note = await new Promise<string | null>((resolve) => setConfirming({ name: tk.name, reopen: reopens, askNote: !given, resolve }));
      setConfirming(null);
      if (note === null) return null;
      if (note && !given) body.updateComment = note;
    }
    const moves = tk && tk.kind === 'milestone' && ((patch.endDate !== undefined && patch.endDate !== tk.endDate) || (patch.startDate !== undefined && patch.startDate !== tk.endDate));
    if (tk && moves) {
      const to = (patch.endDate ?? patch.startDate) as string;
      const reason = await new Promise<string | null>((resolve) => setAsking({ name: tk.name, from: tk.endDate, to, resolve }));
      setAsking(null);
      if (reason === null) return null;
      body.changeReason = reason;
    }
    return run(api.patch<Plan>(`/api/tasks/${taskId}`, body));
  };

  const indent = (dir: 1 | -1) => {
    if (!selected) return;
    if (dir === -1) {
      if (!selected.parentId) return;
      const parent = tasks.find((x) => x.id === selected.parentId);
      patchTask(selected.id, { parentId: parent?.parentId ?? null });
      return;
    }
    const siblings = ordered.filter((x) => (x.parentId ?? null) === (selected.parentId ?? null));
    const i = siblings.findIndex((x) => x.id === selected.id);
    const prev = siblings[i - 1];
    // Only into what may hold it: a task into a milestone, a milestone or a phase into a phase.
    const fits = selected.kind === 'task' ? prev?.kind === 'milestone' : prev?.kind === 'summary';
    if (prev && fits) patchTask(selected.id, { parentId: prev.id });
    else toast(t(selected.kind === 'task' ? 'taskNeedsMilestone' : 'milestoneNeedsPhase'), 'bad');
  };

  const deleteTask = async (taskId: number) => {
    const tk = tasks.find((x) => x.id === taskId);
    if (!tk) return;
    // Say how much goes with a phase: everything under it, at any depth.
    const under = new Set<number>([taskId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of tasks) if (x.parentId && under.has(x.parentId) && !under.has(x.id)) (under.add(x.id), (grew = true));
    }
    const n = under.size - 1;
    if (!window.confirm(n > 0 ? t('confirmDeleteWithChildren', { name: tk.name, n }) : t('confirmDelete', { name: tk.name }))) return;
    await run(api.del<Plan>(`/api/tasks/${taskId}`));
    setSelectedId(null);
    setPanelOpen(false);
  };

  const crit = criticalPath(tasks, dependencies);
  const thisWeekUpdate = data.updates.find((u) => u.weekStart === thisWeek) ?? null;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href="#/portfolio">{t('portfolio')}</a>
        <CaretRight size={12} style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} aria-hidden />
        <span>
          <span className="swatch" style={{ background: color, display: 'inline-block', marginInlineEnd: 6, verticalAlign: '-1px' }} />
          {deptName(d, lang)}
        </span>
        <span className="code" style={{ marginInlineStart: 4 }}>
          {project.code}
        </span>
      </nav>

      <header className="project-head">
        <div className="project-title-row">
          <h1 className="project-title">{projectName(project, lang)}</h1>
          <LearnMore page="project" />
          <div className="toolbar">
            <span title={t('healthFromPlan')}>
              <HealthBadge health={project.health} pill />
            </span>
            {!memberView && (
              <ExportButton url={`/api/projects/${id}/export.xlsx`} title={t('exportProjectHint')}>
                <FileXls size={15} aria-hidden />
                {t('exportExcel')}
              </ExportButton>
            )}
            {can('projects.edit_all') && (
              <button className="btn btn-danger" onClick={() => setDeleting(true)} title={t('deleteProjectTitle')}>
                <Trash size={15} aria-hidden />
                {t('deleteProject')}
              </button>
            )}
            {canWriteUpdate && (
              <button className="btn btn-primary" onClick={() => setWriting(true)}>
                <PencilSimple size={15} aria-hidden />
                {thisWeekUpdate ? t('editUpdate') : t('writeUpdate')}
              </button>
            )}
          </div>
        </div>

        <AiPmBar detail={data} canGovern={canGovern} onChanged={reload} />
        <DependsBar detail={data} />
        <ClosureBar detail={data} canGovern={canGovern} canClose={canClose} onChanged={reload} />
        {allDone && <AllDoneDialog canClose={canClose} onClose={() => setAllDone(false)} />}

        <div className="facts">
          <div className="fact">
            <span>{t('manager')}</span>
            <Person user={user(project.managerId)} name={project.managerName} />
          </div>
          <div className="fact">
            <span>{t('sponsor')}</span>
            <span>{project.sponsor || '-'}</span>
          </div>
          <div className="fact">
            <span>
              {t('start')} - {t('finish')}
            </span>
            <span className="num">
              {fmtDate(project.startDate, lang)} - {fmtDate(project.endDate, lang, true)}
            </span>
          </div>
          <div className="fact">
            <span>{t('baseline')}</span>
            <span style={{ color: slip && slip > 0 ? 'var(--bad)' : undefined }} title={slip === null && project.baselineEnd ? t('baselinePendingHint') : undefined}>
              {slip === null ? t(project.baselineEnd ? 'baselinePending' : 'noBaseline') : slip > 0 ? t('slipDays', { n: slip }) : slip < 0 ? t('earlyDays', { n: -slip }) : t('onBaseline')}
            </span>
          </div>
          <div className="fact" style={{ minWidth: 200 }}>
            <span>{t('progress')}</span>
            <span style={{ display: 'grid', gridTemplateColumns: '44px 1fr', alignItems: 'center', gap: 8 }}>
              <span className="num">{project.progress}%</span>
              <Meter value={project.progress} expected={project.startDate <= today ? expected : undefined} />
            </span>
          </div>
          <div className="fact">
            <span>{t('priority')}</span>
            <span className={`prio-${project.priority}`}>{t(`priority_${project.priority}`)}</span>
          </div>
        </div>

        <div className="stages" role="list" aria-label={t('stage')}>
          {STAGES.map((s, i) => {
            const cur = STAGES.indexOf(project.stage);
            const state = i < cur ? 'past' : i === cur ? 'current' : 'future';
            return (
              <button
                key={s}
                role="listitem"
                className="stage"
                data-state={state}
                data-editable={false}
                disabled
                title={`${t(`stageHint_${s}`)} ${t('stageFromPlan')}`}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <i />
                {t(`stage_${s}`)}
              </button>
            );
          })}
        </div>
      </header>

      <nav className="tabs" aria-label={t('project')}>
        {tabs.map((k) => (
          <a key={k} className="tab" href={`#/projects/${id}/${k}`} aria-current={currentTab === k ? 'page' : undefined}>
            {currentTab === k && <motion.span layoutId="tab-ink" className="tab-ink" transition={SPRING} />}
            {t(k)}
            {k === 'plan' && <span className="count num">{tasks.length}</span>}
            {k === 'updates' && <span className="count num">{data.updates.length}</span>}
            {k === 'meetings' && <span className="count num">{new Set(data.meetingNotes.map((n) => n.week)).size}</span>}
            {k === 'risks' && <span className="count num">{data.risks.filter((r) => r.status !== 'closed').length}</span>}
            {k === 'team' && <span className="count num">{data.members.length}</span>}
          </a>
        ))}
      </nav>

      <div key={currentTab} className="tab-body">
      {currentTab === 'plan' && guideBaseline && canGovern && datesToApprove > 0 && (
        <div className="guide-banner" role="note">
          <CalendarCheck size={22} weight="duotone" aria-hidden />
          <div>
            <strong>{t('guideBaselineTitle')}</strong>
            <p>{t('guideBaselineBody', { n: datesToApprove })}</p>
          </div>
          <div className="guide-actions">
            <button className="btn btn-primary" onClick={approveDates}>
              {t('guideBaselineApprove')}
            </button>
            <button className="btn btn-ghost" onClick={() => setGuideBaseline(false)}>
              {t('guideBaselineLater')}
            </button>
          </div>
        </div>
      )}
      {currentTab === 'plan' &&
        (tasks.length === 0 ? (
          <div className="panel">
            <Empty
              title={t('emptyPlanTitle')}
              body={t('emptyPlanBody')}
              action={
                canGovern && (
                  <button className="btn btn-primary" onClick={() => addTask('summary')}>
                    <Plus size={15} weight="bold" aria-hidden />
                    {t('addFirstPhase')}
                  </button>
                )
              }
            />
          </div>
        ) : (
          <>
            <Gantt
              plan={{ tasks, dependencies }}
              color={color}
              canEdit={canGovern}
              today={today}
              users={usersById}
              selectedId={selectedId}
              onSelect={async (tid) => {
                // Another task while an update is not posted: ask first.
                if (panelOpen && tid !== selectedId && !(await confirmLeave())) return;
                setSelectedId(tid);
                if (tid === null) setPanelOpen(false);
              }}
              onOpen={async (tid) => {
                if (panelOpen && tid !== selectedId && !(await confirmLeave())) return;
                setSelectedId(tid);
                // Someone who works on the project but does not run it opens only the tasks given to them.
                const picked = tasks.find((x) => x.id === tid);
                if (picked && !picked.systemKey && !canGovern && can('projects.edit_own') && !isMine(picked, me)) {
                  toast(t('notYourTask'), 'bad');
                  return;
                }
                setPanelOpen(true);
              }}
              onMove={(tid, s, e) => patchTask(tid, { startDate: s, endDate: e })}
              onLink={(p, s) => run(api.post<Plan>(`/api/projects/${id}/dependencies`, { predecessorId: p, successorId: s }))}
              onRename={(tid, name) => patchTask(tid, { name })}
              onAdd={addTask}
              onIndent={indent}
              onDelete={() => selected && deleteTask(selected.id)}
              canDelete={canDeleteTask}
              baselined={baselined}
              mine={memberView || (canGovern && tasks.some((x) => x.kind !== 'summary' && isMine(x, me))) ? (x: Task) => isMine(x, me) : undefined}
              mineOnlyMarks={!memberView}
              baseline={
                baselineMode === 'all'
                  ? { label: t('rebaseline'), onClick: () => setRebaselining(true) }
                  : baselineMode === 'missing'
                    ? {
                        label: t('baselineNew', { n: datesToApprove }),
                        onClick: approveDates,
                        highlight: guideBaseline,
                      }
                    : null
              }
              editingId={editingId}
              setEditingId={setEditingId}
            />
            {panelOpen && selected?.systemKey === 'closure_docs' && (
              <ClosureDocsPanel detail={data} canGovern={canGovern} canClose={canClose} onClose={() => setPanelOpen(false)} />
            )}
            {panelOpen && selected && selected.systemKey !== 'closure_docs' && (
              <TaskPanel
                task={selected}
                tasks={tasks}
                dependencies={dependencies}
                users={meta.users}
                departmentId={project.departmentId}
                baselined={baselined}
                canEdit={canEdit && (canGovern || (selected.kind !== 'summary' && isMine(selected, me)))}
                isCritical={crit.critical.has(selected.id)}
                floatDays={crit.floatDays.get(selected.id)}
                onClose={() => setPanelOpen(false)}
                onPatch={(patch) => patchTask(selected.id, patch)}
                onReload={reload}
                onAddDependency={(pred, lag) =>
                  run(api.post<Plan>(`/api/projects/${id}/dependencies`, { predecessorId: pred, successorId: selected.id, lagDays: lag }))
                }
                onRemoveDependency={(depId) => run(api.del<Plan>(`/api/dependencies/${depId}`))}
                onDelete={() => deleteTask(selected.id)}
                canGovern={canGovern}
              />
            )}
          </>
        ))}

      {currentTab === 'updates' && <UpdatesTab updates={data.updates} canEdit={canWriteUpdate} onWrite={() => setWriting(true)} thisWeek={thisWeek} />}
      {currentTab === 'risks' && <RisksTab projectId={id} risks={data.risks} canEdit={canEdit} onChange={reload} />}
      {currentTab === 'changes' && <ChangesTab detail={data} canAsk={canEdit} canKeep={canGovern} onApplied={reload} />}
      {currentTab === 'team' && <TeamTab detail={data} canEdit={canGovern} onSaved={setData} />}
      {currentTab === 'details' && memberView && <ProjectBrief detail={data} />}
      {currentTab === 'details' && !memberView && (
        <>
          {can('projects.edit_all') && (
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-body">
                <DependsOnEditor detail={data} onSaved={reload} />
              </div>
            </div>
          )}
          <DetailsTab detail={data} canEdit={canGovern} canGovern={canGovern} onSave={patchProject} />
        </>
      )}
      {currentTab === 'meetings' && <MeetingsTab detail={data} />}
      {currentTab === 'activity' && <ActivityTab detail={data} />}
      </div>

      {asking && (
        <ReasonDialog
          name={asking.name}
          from={asking.from}
          to={asking.to}
          needsApproval={!canGovern}
          onConfirm={(r) => asking.resolve(r)}
          onCancel={() => asking.resolve(null)}
        />
      )}
      {deleting && <DeleteProject id={project.id} name={`${project.code} ${project.name}`} onClose={() => setDeleting(false)} />}
      {confirming && (
        <ConfirmDone
          name={confirming.name}
          reopen={confirming.reopen}
          askNote={confirming.askNote}
          onConfirm={(note) => confirming.resolve(note)}
          onCancel={() => confirming.resolve(null)}
        />
      )}
      {rebaselining && (
        <RebaselineDialog
          projectId={id}
          slipped={tasks.filter((x) => x.baselineEnd && x.baselineEnd !== x.endDate).length}
          onClose={() => setRebaselining(false)}
          onDone={(d) => {
            setRebaselining(false);
            setData(d);
            toast(t('baselineSet'));
          }}
        />
      )}
      {writing && (
        <UpdateDialog
          projectId={id}
          projectLabel={`${project.code} ${projectName(project, lang)}`}
          week={thisWeek}
          existing={thisWeekUpdate}
          planProgress={project.progress}
          currentHealth={project.health}
          onClose={() => setWriting(false)}
          onSaved={() => {
            setWriting(false);
            toast(t('saved'));
            reload();
          }}
        />
      )}
    </>
  );
}

// ---- Updates ----------------------------------------------------------------

/**
 * Closing a project: its owner (or department head) asks, a PMO admin decides. The bar shows where the
 * request stands, and gives the right button to each side.
 */
/** The tasks someone reports on without running the project: given to them, or shared with them as a co-owner. */
function isMine(task: Task, me: { id: number; name: string }): boolean {
  if (task.assigneeId === me.id) return true;
  const name = me.name.trim().toLowerCase();
  return (task.coOwners ?? '').split(/\s*[,،]\s*/).some((n) => n.trim().toLowerCase() === name);
}

function ClosureBar({ detail, canGovern, canClose, onChanged }: { detail: ProjectDetail; canGovern: boolean; canClose: boolean; onChanged: () => void }) {
  const { t, lang } = useT();
  const { meta } = useApp();
  const toast = useToast();
  const c = detail.closure;
  const [asking, setAsking] = useState<'request' | 'approve' | 'reject' | 'close' | 'reopen' | null>(null);
  const [note, setNote] = useState('');
  // The Delivery Document that goes with a request to close: a link, a file, or both (one at least).
  const [deliveryUrl, setDeliveryUrl] = useState('');
  const [deliveryFile, setDeliveryFile] = useState<{ name: string; data: string } | null>(null);
  // The two documents a project cannot close without.
  const [reportFile, setReportFile] = useState<{ name: string; data: string } | null>(null);
  const [checklistFile, setChecklistFile] = useState<{ name: string; data: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const closed = detail.project.health === 'done';
  const pending = c?.status === 'pending';
  // Closing waits for every milestone: the server refuses it as well.
  const openMilestones = openMilestonesOf(detail);
  const askRef = useLatest(() => {
    if (closed || pending || openMilestones > 0) return;
    if (canClose) setAsking('close');
    else if (canGovern) setAsking('request');
  });
  useEffect(() => {
    const on = () => askRef.current();
    window.addEventListener('pmo:closure-ask', on);
    return () => window.removeEventListener('pmo:closure-ask', on);
  }, [askRef]);
  const send = async () => {
    if (!asking || (!c && (asking === 'approve' || asking === 'reject'))) return;
    setBusy(true);
    try {
      // The PMO closes directly (no request to itself), or reopens a closed project: its health is read from the plan again.
      if (asking === 'close' || asking === 'request') await api.post(`/api/projects/${detail.project.id}/closure-request`, { note, deliveryUrl, deliveryFile, reportFile, checklistFile });
      else if (asking === 'reopen') await api.patch(`/api/projects/${detail.project.id}`, { health: 'on_track' });
      else await api.post(`/api/closure-requests/${c!.id}/decide`, { decision: asking, note });
      setAsking(null);
      setNote('');
      setDeliveryUrl('');
      setDeliveryFile(null);
      setReportFile(null);
      setChecklistFile(null);
      onChanged();
      toast(t('saved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  // Both closure documents picked: sent at once, no extra click.
  const sendRef = useLatest(send);
  useEffect(() => {
    if ((asking === 'request' || asking === 'close') && reportFile && checklistFile && !busy) void sendRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportFile, checklistFile]);
  const canAsk = canGovern && !canClose && !closed && !pending && openMilestones === 0;
  const showRejected = !pending && !closed && c?.status === 'rejected';
  const showApproved = closed && c?.status === 'approved';
  const canFinish = canClose && !closed && !pending && openMilestones === 0;
  const canReopen = canClose && closed;
  const waiting = canGovern && !closed && !pending && openMilestones > 0;
  if (!waiting && !pending && !canAsk && !showRejected && !showApproved && !canFinish && !canReopen) return null;
  return (
    <>
      <div className={`closure-bar ${pending ? 'pending' : ''}`} role="status">
        <span className="closure-text">
          {pending && c && t('closurePending', { by: c.requestedByName ?? '', date: fmtDateTime(c.createdAt, lang) })}
          {showRejected && c && t('closureRejected', { date: c.decidedAt ? fmtDateTime(c.decidedAt, lang) : '' })}
          {showApproved && c && t('closureApproved', { by: c.decidedByName ?? '', date: c.decidedAt ? fmtDateTime(c.decidedAt, lang) : '' })}
          {waiting && t('closureWaitMilestones', { n: openMilestones })}
          {!c && canAsk && t('closureHint')}
          {canFinish && !showRejected && t('closureDirectHint')}
          {canReopen && !showApproved && t('closureClosed')}
          {c?.note && pending && <em> {'⁨'}{c.note}{'⁩'}</em>}
          {c?.decisionNote && !pending && <em> {'⁨'}{c.decisionNote}{'⁩'}</em>}
          {c && (pending || showApproved) && (c.deliveryUrl || c.deliveryFileName || c.reportFileName) && (
            <>
              {' '}
              <DeliveryDoc requestId={c.id} url={c.deliveryUrl} fileName={c.deliveryFileName} reportFileName={c.reportFileName} checklistFileName={c.checklistFileName} />
            </>
          )}
        </span>
        {canAsk && (
          <button className="btn btn-sm" onClick={() => setAsking('request')}>
            {t('closureRequest')}
          </button>
        )}
        {canFinish && (
          <button className="btn btn-sm btn-primary" onClick={() => setAsking('close')}>
            {t('closureCloseNow')}
          </button>
        )}
        {canReopen && (
          <button className="btn btn-sm" onClick={() => setAsking('reopen')}>
            {t('closureReopen')}
          </button>
        )}
        {pending && canClose && c && c.requestedBy !== meta.me.id && openMilestones === 0 && (
          <>
            <button className="btn btn-sm btn-primary" onClick={() => setAsking('approve')}>
              {t('closureApprove')}
            </button>
            <button className="btn btn-sm" onClick={() => setAsking('reject')}>
              {t('closureReject')}
            </button>
          </>
        )}
      </div>
      {asking && (
        <Dialog
          title={asking === 'request' ? t('closureRequestTitle') : asking === 'approve' ? t('closureApprove') : asking === 'close' ? t('closureCloseNow') : asking === 'reopen' ? t('closureReopen') : t('closureReject')}
          onClose={() => setAsking(null)}
          width={520}
          footer={
            <>
              <button className="btn" onClick={() => setAsking(null)}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={busy || ((asking === 'request' || asking === 'close') && (!reportFile || !checklistFile))} onClick={send}>
                {asking === 'request' ? t('closureSend') : asking === 'close' ? t('closureCloseNow') : asking === 'reopen' ? t('closureReopen') : t('save')}
              </button>
            </>
          }
        >
          {(asking === 'close' || asking === 'reopen') && <p>{t(asking === 'close' ? 'closureCloseConfirm' : 'closureReopenConfirm', { name: detail.project.name })}</p>}
          {asking !== 'close' && asking !== 'reopen' && <Field label={asking === 'request' ? t('closureNote') : t('closureDecisionNote')} hint={asking === 'request' ? t('closureRequestHint') : undefined}>
            <MentionTextarea className="input" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>}
          {(asking === 'request' || asking === 'close') && (
            <div className="form-grid" style={{ marginTop: 14 }}>
              <p className="muted span-2" style={{ margin: 0, fontSize: 12.5 }}>{t('closureAutoHint')}</p>
              <Field label={t('deliveryOptional')} hint={t('deliveryDocHint')} className="span-2">
                <input className="input" type="url" placeholder="https://..." dir="ltr" value={deliveryUrl} onChange={(e) => setDeliveryUrl(e.target.value)} />
              </Field>
              <Field label={t('deliveryFile')} hint={deliveryFile ? deliveryFile.name : t('deliveryFileHint')} className="span-2">
                <input
                  className="input"
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.png,.jpg,.jpeg,.zip"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return setDeliveryFile(null);
                    const r = await readDeliveryFile(f, (why) => toast(t(why === 'big' ? 'deliveryTooBig' : 'deliveryReadFailed'), 'bad'));
                    if (!r) e.target.value = '';
                    setDeliveryFile(r);
                  }}
                />
              </Field>
              {(
                [
                  ['closureReport', 'closure-report', reportFile, setReportFile],
                  ['closureChecklist', 'sign-off-checklist', checklistFile, setChecklistFile],
                ] as const
              ).map(([label, template, value, setValue]) => (
                <Field key={template} label={`${t(label)} *`} hint={value ? value.name : t('closureDocsHint')} className="span-2">
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      className="input"
                      style={{ flex: 1, minWidth: 200 }}
                      type="file"
                      accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.png,.jpg,.jpeg,.zip"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return setValue(null);
                        const r = await readDeliveryFile(f, (why) => toast(t(why === 'big' ? 'deliveryTooBig' : 'deliveryReadFailed'), 'bad'));
                        if (!r) e.target.value = '';
                        setValue(r);
                      }}
                    />
                    <a className="btn btn-ghost btn-sm" href={`/api/templates/${template}`} download>
                      {t('closureTemplate')}
                    </a>
                  </div>
                </Field>
              ))}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}

function UpdatesTab({ updates, canEdit, onWrite, thisWeek }: { updates: StatusUpdate[]; canEdit: boolean; onWrite: () => void; thisWeek: string }) {
  const { t, lang } = useT();
  const { user } = useApp();
  if (updates.length === 0) {
    return (
      <div className="panel">
        <Empty
          title={t('noUpdateYet')}
          action={
            canEdit && (
              <button className="btn btn-primary" onClick={onWrite}>
                {t('writeUpdate')}
              </button>
            )
          }
        />
      </div>
    );
  }
  return (
    <div className="panel">
      {updates.map((u, i) => (
        <article key={u.id} className="update-card enter" style={stagger(i)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong>{t('weekOf', { d: fmtDate(u.weekStart, lang, true) })}</strong>
            <HealthBadge health={u.health} pill />
            <span className="num ink-2">{u.progress}%</span>
            <span className="muted" style={{ marginInlineStart: 'auto', fontSize: 12.5 }}>
              {user(u.authorId)?.name}, {fmtDateTime(u.submittedAt, lang)}
            </span>
            {canEdit && u.weekStart === thisWeek && (
              <button className="btn btn-sm" onClick={onWrite}>
                {t('edit')}
              </button>
            )}
          </div>
          <UpdateBody u={u} />
          {u.notes.length > 0 && (
            <div>
              <div className="code" style={{ marginBottom: 2 }}>
                {t('meetingNotes')}
              </div>
              {u.notes.map((n) => (
                <div key={n.id} className="note">
                  <span className={`note-kind k-${n.kind}`}>{t(n.kind)}</span>
                  <span>
                    {n.body}
                    <NoteStamp n={n} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export function UpdateBody({ u }: { u: StatusUpdate }) {
  const { t } = useT();
  const blocks: [string, string, boolean][] = [
    [t('accomplishments'), u.accomplishments, false],
    [t('nextSteps'), u.nextSteps, false],
    [t('blockers'), u.blockers, false],
    [t('decisions'), u.decisions, true],
  ];
  return (
    <div className="update-grid">
      {blocks
        .filter(([, v]) => v.trim())
        .map(([label, v, isDecision]) => (
          <div key={label} className={`update-block ${isDecision ? 'is-decision' : ''}`}>
            <h4>{label}</h4>
            <p>{v}</p>
          </div>
        ))}
    </div>
  );
}

// ---- Risks ------------------------------------------------------------------

function RisksTab({ projectId, risks, canEdit, onChange }: { projectId: number; risks: Risk[]; canEdit: boolean; onChange: () => void }) {
  const { t, lang } = useT();
  const { meta, user } = useApp();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<Risk> | null>(null);

  const save = async () => {
    if (!editing) return;
    try {
      if (editing.id) await api.patch(`/api/risks/${editing.id}`, editing);
      else await api.post(`/api/projects/${projectId}/risks`, editing);
      setEditing(null);
      toast(t('saved'));
      onChange();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  const score = (r: Risk) => ({ low: 1, medium: 2, high: 3 })[r.impact] * ({ low: 1, medium: 2, high: 3 })[r.likelihood];

  return (
    <>
      {canEdit && (
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <button className="btn" onClick={() => setEditing({ kind: 'risk', impact: 'medium', likelihood: 'medium', status: 'open' })}>
            <Plus size={15} aria-hidden />
            {t('raiseRisk')}
          </button>
          <button className="btn" onClick={() => setEditing({ kind: 'issue', impact: 'high', likelihood: 'high', status: 'open' })}>
            <Plus size={15} aria-hidden />
            {t('logIssue')}
          </button>
        </div>
      )}
      {risks.length === 0 ? (
        <div className="panel">
          <Empty title={t('noRisksTitle')} body={t('noRisksBody')} />
        </div>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('title')}</th>
                <th>{t('impact')}</th>
                <th>{t('likelihood')}</th>
                <th>{t('owner')}</th>
                <th>{t('dueDate')}</th>
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((r, i) => (
                <tr
                  key={r.id}
                  className={`enter ${canEdit ? 'clickable' : ''}`}
                  onClick={() => canEdit && setEditing(r)}
                  style={stagger(i, { opacity: r.status === 'closed' ? 0.55 : 1 })}
                >
                  <td style={{ minWidth: 280 }}>
                    <div className="code" style={{ color: r.kind === 'issue' ? 'var(--bad)' : undefined }}>
                      {t(r.kind)}
                      {score(r) >= 6 && r.status !== 'closed' ? ` / ${t('level_high')}` : ''}
                    </div>
                    <div style={{ fontWeight: 500 }}>{r.title}</div>
                    {r.mitigation && <div className="muted" style={{ fontSize: 13 }}>{r.mitigation}</div>}
                  </td>
                  <td>{t(`level_${r.impact}`)}</td>
                  <td>{t(`level_${r.likelihood}`)}</td>
                  <td>
                    <Person user={user(r.ownerId)} />
                  </td>
                  <td className="num">{fmtDate(r.dueDate, lang) || '-'}</td>
                  <td>{t(`riskStatus_${r.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Dialog
          title={editing.id ? editing.title : editing.kind === 'issue' ? t('logIssue') : t('raiseRisk')}
          onClose={() => setEditing(null)}
          footer={
            <>
              {editing.id && (
                <button
                  className="btn btn-ghost btn-danger"
                  style={{ marginInlineEnd: 'auto' }}
                  onClick={async () => {
                    await api.del(`/api/risks/${editing.id}`);
                    setEditing(null);
                    onChange();
                  }}
                >
                  <Trash size={15} aria-hidden />
                  {t('delete')}
                </button>
              )}
              <button className="btn" onClick={() => setEditing(null)}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={!editing.title?.trim()} onClick={save}>
                {t('save')}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={t('title')} className="span-2">
              <input className="input" value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </Field>
            <Field label={t('risk')}>
              <select className="select" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as RiskKind })}>
                <option value="risk">{t('risk')}</option>
                <option value="issue">{t('issue')}</option>
              </select>
            </Field>
            <Field label={t('status')}>
              <select className="select" value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as RiskStatus })}>
                {(['open', 'mitigating', 'closed'] as RiskStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {t(`riskStatus_${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('impact')}>
              <select className="select" value={editing.impact} onChange={(e) => setEditing({ ...editing, impact: e.target.value as Level })}>
                {(['low', 'medium', 'high'] as Level[]).map((l) => (
                  <option key={l} value={l}>
                    {t(`level_${l}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('likelihood')}>
              <select className="select" value={editing.likelihood} onChange={(e) => setEditing({ ...editing, likelihood: e.target.value as Level })}>
                {(['low', 'medium', 'high'] as Level[]).map((l) => (
                  <option key={l} value={l}>
                    {t(`level_${l}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('owner')}>
              <select className="select" value={editing.ownerId ?? ''} onChange={(e) => setEditing({ ...editing, ownerId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t('unassigned')}</option>
                {meta.users.filter((u) => u.active).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('dueDate')}>
              <DateInput className="input" value={editing.dueDate ?? ''} onChange={(e) => setEditing({ ...editing, dueDate: e.target.value || null })} />
            </Field>
            <Field label={t('mitigation')} className="span-2">
              <MentionTextarea className="textarea" value={editing.mitigation ?? ''} onChange={(e) => setEditing({ ...editing, mitigation: e.target.value })} />
            </Field>
          </div>
        </Dialog>
      )}
    </>
  );
}

// ---- Team -------------------------------------------------------------------

function TeamTab({ detail, canEdit, onSaved }: { detail: ProjectDetail; canEdit: boolean; onSaved: (d: ProjectDetail) => void }) {
  const { t, lang } = useT();
  const { meta, user, can } = useApp();
  const toast = useToast();
  const [members, setMembers] = useState(detail.members);
  const [adding, setAdding] = useState<number | ''>('');
  const dirty = JSON.stringify(members) !== JSON.stringify(detail.members);
  const taskCount = (uid: number) => detail.tasks.filter((x) => x.assigneeId === uid && x.kind !== 'summary' && x.status !== 'cancelled').length;

  const save = async () => {
    try {
      onSaved(await api.put<ProjectDetail>(`/api/projects/${detail.project.id}/members`, { members }));
      toast(t('saved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  return (
    <div className="panel">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('member')}</th>
              <th>{t('role')}</th>
              <th className="num">{t('plan')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.userId}>
                <td>
                  <Person user={user(m.userId)} size="lg" />
                </td>
                <td>
                  {canEdit && m.userId !== detail.project.managerId ? (
                    <select
                      className="select"
                      style={{ maxWidth: 240 }}
                      value={(TEAM_ROLES as readonly string[]).includes(m.role) && m.role !== 'Project manager' ? m.role : 'Member'}
                      aria-label={t('role')}
                      onChange={(e) => setMembers(members.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                    >
                      {TEAM_ROLES.filter((r) => r !== 'Project manager').map((r) => (
                        <option key={r} value={r}>
                          {teamRoleLabel(r, lang)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    teamRoleLabel(m.userId === detail.project.managerId ? 'Project manager' : m.role, lang)
                  )}
                </td>
                <td className="num ink-2">
                  {taskCount(m.userId)}
                  {/* Nothing given to them: a plain Member does not see the project until they have work in it. */}
                  {taskCount(m.userId) === 0 && m.userId !== detail.project.managerId && (
                    <span className={m.role === 'Member' ? 'team-note is-warn' : 'team-note'}>
                      {m.role === 'Member' ? t('teamNoWorkHidden') : t('teamNoWork')}
                    </span>
                  )}
                </td>
                <td style={{ textAlign: 'end' }}>
                  {canEdit && m.userId !== detail.project.managerId && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setMembers(members.filter((_, j) => j !== i))}>
                      {t('remove')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="panel-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--line)' }}>
          <select className="select" style={{ maxWidth: 280 }} value={adding} aria-label={t('addMember')} onChange={(e) => setAdding(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('addMember')}</option>
            {(() => {
              const free = meta.users.filter((u) => u.active && !members.some((m) => m.userId === u.id));
              const own = free.filter((u) => u.departmentId === detail.project.departmentId);
              const rest = free.filter((u) => u.departmentId !== detail.project.departmentId);
              return (
                <>
                  <optgroup label={own.length ? t('op_yourDept') : `${t('op_yourDept')} · ${t('tm_noneLeft')}`}>
                    {own.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('tm_otherDepts')}>
                    {rest.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                        {u.departmentId ? ` · ${meta.departments.find((d) => d.id === u.departmentId)?.name ?? ''}` : ''}
                      </option>
                    ))}
                  </optgroup>
                </>
              );
            })()}
          </select>
          <button
            className="btn"
            disabled={!adding}
            onClick={() => {
              if (adding) setMembers([...members, { userId: adding, role: t('member') }]);
              setAdding('');
            }}
          >
            {t('add')}
          </button>
          <span className="hint" style={{ alignSelf: 'center' }}>{t('tm_crossHint')}</span>
          <button className="btn btn-primary" style={{ marginInlineStart: 'auto' }} disabled={!dirty} onClick={save}>
            {t('save')}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Details (charter) ----------------------------------------------------------

function DetailsTab({
  detail,
  canEdit,
  canGovern,
  onSave,
}: {
  detail: ProjectDetail;
  canEdit: boolean;
  canGovern: boolean;
  onSave: (b: Record<string, unknown>) => Promise<void>;
}) {
  const { t, lang } = useT();
  const { meta } = useApp();
  const p = detail.project;
  const [form, setForm] = useState({
    name: p.name,
    nameAr: p.nameAr ?? '',
    departmentId: p.departmentId,
    managerId: p.managerId ?? '',
    sponsor: p.sponsor ?? '',
    ownerName: p.managerName ?? '',
    successMetric: p.successMetric ?? '',
    successTarget: p.successTarget ?? '',
    problemStatement: p.problemStatement ?? '',
    stakeholders: p.stakeholders ?? '',
    businessCase: p.businessCase ?? '',
    resources: p.resources ?? '',
    riskPlan: p.riskPlan ?? '',
    deliverables: p.deliverables ?? '',
    acceptanceCriteria: p.acceptanceCriteria ?? '',
    priority: p.priority,
    quarterId: p.quarterId ?? '',
    objective: p.objective ?? '',
    scope: p.scope ?? '',
    description: p.description ?? '',
    budget: p.budget === null ? '' : String(p.budget),
  });
  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));
  const ro = !canEdit;
  // Department, manager, priority, quarter and budget: the manager or the PMO.
  const roGov = !canGovern;
  // After the baseline, budget, objective and scope change only through a change request.
  const locked = Boolean(p.baselineEnd);

  return (
    <div className="panel">
      <div className="panel-body">
        <div className="form-grid" style={{ maxWidth: 880 }}>
          <Field label={t('name')}>
            <input className="input" disabled={ro} value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={t('nameAr')}>
            <input className="input" dir="rtl" disabled={ro} value={form.nameAr} onChange={(e) => set('nameAr', e.target.value)} />
          </Field>
          <Field label={t('department')}>
            <select className="select" disabled={roGov} value={form.departmentId} onChange={(e) => set('departmentId', Number(e.target.value))}>
              {meta.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {deptName(d, lang)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('manager')}>
            <select className="select" disabled={roGov} value={form.managerId} onChange={(e) => set('managerId', Number(e.target.value))}>
              {meta.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('sponsor')}>
            <SponsorSelect disabled={ro} value={form.sponsor ?? ''} onChange={(v) => set('sponsor', v)} />
          </Field>
          <Field label={t('priority')}>
            <select className="select" disabled={roGov} value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {t(`priority_${x}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('quarter')}>
            <select className="select" disabled={roGov} value={form.quarterId} onChange={(e) => set('quarterId', Number(e.target.value))}>
              {meta.quarters.map((q) => (
                <option key={q.id} value={q.id}>
                  Q{q.q} {q.year}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('budget')}>
            <input className="input num" disabled={roGov || locked} inputMode="decimal" value={form.budget} onChange={(e) => set('budget', e.target.value)} />
            {locked ? <span className="hint">{t('cr_lockedField')}</span> : p.budget !== null && <span className="hint">{fmtNumber(p.budget, lang)}</span>}
          </Field>
          <Field label={t('responsibleOwner')} hint={p.managerId ? t('linkedToUser') : t('fromTracker')}>
            <input className="input" disabled={ro || !!p.managerId} value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
          </Field>
          <Field label={t('gateLabel')}>
            <input className="input" disabled value={p.gate ?? '-'} readOnly />
          </Field>
          <Field label={t('successMetric')} className="span-2">
            <textarea className="textarea" disabled={ro} value={form.successMetric} onChange={(e) => set('successMetric', e.target.value)} />
          </Field>
          <Field label={t('successTarget')} className="span-2">
            <textarea className="textarea" disabled={ro} value={form.successTarget} onChange={(e) => set('successTarget', e.target.value)} />
          </Field>
          <Field label={t('objective')} className="span-2" hint={locked ? t('cr_lockedField') : undefined}>
            <textarea className="textarea" disabled={ro || locked} value={form.objective} onChange={(e) => set('objective', e.target.value)} />
          </Field>
          <Field label={t('scope')} className="span-2" hint={locked ? t('cr_lockedField') : undefined}>
            <textarea className="textarea" disabled={ro || locked} value={form.scope} onChange={(e) => set('scope', e.target.value)} />
          </Field>
          {(['problemStatement', 'stakeholders', 'businessCase', 'resources', 'riskPlan', 'deliverables', 'acceptanceCriteria'] as const).map((k) => {
            const f = Object.values(STAGE_FIELDS).flat().find((x) => x.key === k)!;
            return (
              <Field key={k} label={lang === 'ar' ? f.ar : f.en} className="span-2">
                {k === 'stakeholders' ? (
                  <PeoplePicker label={lang === 'ar' ? f.ar : f.en} disabled={ro} value={form[k]} onChange={(v) => set(k, v)} />
                ) : (
                  <textarea className="textarea" dir="auto" disabled={ro} value={form[k]} onChange={(e) => set(k, e.target.value)} />
                )}
              </Field>
            );
          })}
          <Field label={t('description')} className="span-2">
            <textarea className="textarea" disabled={ro} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </div>
      </div>
      {canEdit && (
        <div className="dialog-foot" style={{ justifyContent: 'space-between' }}>
          {meta.permissions.includes('projects.archive') ? (
            <button
              className="btn btn-ghost btn-danger"
              onClick={async () => {
                if (!window.confirm(t('confirmArchive'))) return;
                await api.post(`/api/projects/${p.id}/archive`);
                navigate('/portfolio');
              }}
            >
              <Archive size={15} aria-hidden />
              {t('archive')}
            </button>
          ) : (
            <span />
          )}
          <button className="btn btn-primary" onClick={() => onSave(form)}>
            {t('save')}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Re-baseline --------------------------------------------------------------
// Replaces every original date with today's plan, so slips start from zero.
// The PMO's decision, with the reason on record in the activity log.

function RebaselineDialog({
  projectId,
  slipped,
  onClose,
  onDone,
}: {
  projectId: number;
  slipped: number;
  onClose: () => void;
  onDone: (d: ProjectDetail) => void;
}) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<ProjectDetail>(`/api/projects/${projectId}/baseline`, { mode: 'all', reason: reason.trim() }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('rebaselineTitle')}
      onClose={onClose}
      width={520}
      footer={
        <>
          {error && (
            <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary btn-danger-solid" disabled={busy || reason.trim().length < 5} onClick={save}>
            {t('rebaselineConfirm')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <p className="rebaseline-warn">
          <WarningCircle size={18} weight="fill" aria-hidden style={{ flex: 'none' }} />
          {t('rebaselineBody', { n: slipped })}
        </p>
        <Field label={t('rebaselineReason')} hint={t('rebaselineHint')}>
          <MentionTextarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---- Activity ---------------------------------------------------------------

/** Who wrote a note and when, to the minute. */
export function NoteStamp({ n }: { n: MeetingNote }) {
  const { lang } = useT();
  const { user } = useApp();
  const who = n.authorName ?? (n.authorId ? user(n.authorId)?.name : null);
  return (
    <span className="note-stamp">
      {[who, fmtDateTime(n.createdAt, lang)].filter(Boolean).join(' · ')}
    </span>
  );
}

/** What the weekly meetings decided about this project, week by week, newest first. */
function MeetingsTab({ detail }: { detail: ProjectDetail }) {
  const { t, lang } = useT();
  const weeks = new Map<string, MeetingNote[]>();
  for (const n of detail.meetingNotes) {
    const w = n.week ?? n.createdAt.slice(0, 10);
    weeks.set(w, [...(weeks.get(w) ?? []), n]);
  }
  const order = [...weeks.keys()].sort().reverse();
  if (!order.length) return <div className="panel"><p className="muted" style={{ margin: 0 }}>{t('noMeetingNotes')}</p></div>;
  const extra = (n: MeetingNote) =>
    [
      n.ownerName && (n.kind === 'decision_needed' ? t('decidesBy', { n: n.ownerName }) : n.ownerName),
      n.dueDate && t('dueOn', { d: fmtDate(n.dueDate, lang, true) }),
      n.doneAt && `${t(n.kind === 'blocker' ? 'clearedOn' : 'closedOn', { d: fmtDateTime(n.doneAt, lang) })}`,
    ].filter(Boolean).join(' · ');
  return (
    <div className="panel">
      {order.map((w, i) => (
        <article key={w} className="update-card enter" style={stagger(i)}>
          <strong>{t('meetingOfWeek', { d: fmtDate(w, lang, true) })}</strong>
          {weeks.get(w)!.map((n) => (
            <div key={n.id} className="note">
              <span className={`note-kind k-${n.kind}`}>{t(n.kind)}</span>
              <span style={{ textDecoration: n.doneAt && n.kind === 'action' ? 'line-through' : undefined }}>
                {n.body}
                {extra(n) && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{extra(n)}</span>}
                <NoteStamp n={n} />
              </span>
            </div>
          ))}
        </article>
      ))}
    </div>
  );
}

function ActivityTab({ detail }: { detail: ProjectDetail }) {
  const { t, lang } = useT();
  const { user } = useApp();
  const describe = (a: ProjectDetail['activity'][number]): string => {
    const d = a.detail as Record<string, any>;
    switch (a.action) {
      case 'project.created':
        return lang === 'ar' ? 'أنشأ المشروع' : 'created the project';
      case 'project.updated': {
        // Health and stage changes read as before → after; the rest as a field list.
        const parts: string[] = [];
        if (d.healthFrom) parts.push(`${t('health')}: ${t(`health_${d.healthFrom}` as TKey)} → ${t(`health_${d.health}` as TKey)}`);
        if (d.stageFrom) parts.push(`${t('stage')}: ${t(`stage_${d.stageFrom}` as TKey)} → ${t(`stage_${d.stage}` as TKey)}`);
        const rest = (d.fields ?? []).filter((f: string) => !(d.healthFrom && f === 'health') && !(d.stageFrom && f === 'stage'));
        if (rest.length) parts.push((lang === 'ar' ? 'عدّل ' : 'changed ') + rest.join(', '));
        return parts.join('. ');
      }
      case 'project.status_auto': {
        // Set by the system from the plan, not by a person.
        const parts: string[] = [];
        if (d.healthFrom) parts.push(`${t('health')}: ${t(`health_${d.healthFrom}` as TKey)} → ${t(`health_${d.health}` as TKey)}`);
        if (d.stageFrom) parts.push(`${t('stage')}: ${t(`stage_${d.stageFrom}` as TKey)} → ${t(`stage_${d.stage}` as TKey)}`);
        return `${parts.join('. ')} (${t('fromThePlan')})`;
      }
      case 'task.created':
        return (lang === 'ar' ? 'أضاف ' : 'added ') + `"${d.name}"`;
      case 'task.moved':
        return (lang === 'ar' ? 'حرّك ' : 'moved ') + `"${d.name}" ${fmtDate(d.to?.[0], lang)} - ${fmtDate(d.to?.[1], lang)}`;
      case 'task.progress':
        return `"${d.name}" ${d.from}% → ${d.to}%`;
      case 'task.deleted':
        return (lang === 'ar' ? 'حذف ' : 'deleted ') + `"${d.name}"`;
      case 'dependency.added':
        return lang === 'ar' ? 'ربط مهمتين' : 'linked two tasks';
      case 'baseline.set':
        return lang === 'ar' ? 'ثبّت خط الأساس' : 'set the baseline';
      case 'baseline.filled':
        return lang === 'ar' ? `ثبّت خط الأساس لـ ${d.items} بند جديد` : `baselined ${d.items} new items`;
      case 'baseline.reset':
        return (lang === 'ar' ? 'أعاد ضبط خط الأساس للمشروع كله. السبب: ' : 're-baselined the whole project. Reason: ') + d.reason;
      case 'update.submitted':
        return (lang === 'ar' ? 'سلّم تحديث أسبوع ' : 'filed the update for ') + fmtDate(d.week, lang);
      case 'team.updated':
        return lang === 'ar' ? 'عدّل الفريق' : 'updated the team';
      case 'change.deleted':
        return (lang === 'ar' ? 'حذف طلب التغيير ' : 'deleted the change request ') + d.code;
      default:
        return a.action.replace('.', ' ') + (d.title ? `: ${d.title}` : d.body ? `: ${d.body}` : '');
    }
  };
  return (
    <div className="panel">
      {detail.activity.length === 0 ? (
        <Empty title="-" />
      ) : (
        <ul className="mlist" style={{ padding: '8px 18px' }}>
          {detail.activity.map((a) => (
            <li key={a.id} style={{ gridTemplateColumns: '120px minmax(0,1fr)', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="muted num" style={{ fontSize: 12.5 }}>
                {fmtDateTime(a.createdAt, lang)}
              </span>
              <span>
                <strong style={{ fontWeight: 500 }}>{user(a.userId)?.name ?? 'System'}</strong> {describe(a)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What a team member needs to know about the project they work on: its purpose and what success looks like. */
function ProjectBrief({ detail }: { detail: ProjectDetail }) {
  const { t, lang } = useT();
  const { dept } = useApp();
  const p = detail.project;
  const label = (key: string) => {
    for (const fields of Object.values(STAGE_FIELDS)) {
      const f = fields.find((x) => x.key === key);
      if (f) return lang === 'ar' ? f.ar : f.en;
    }
    return key;
  };
  const rows: [string, string | null][] = [
    [label('objective'), p.objective],
    [label('problemStatement'), p.problemStatement],
    [label('scope'), p.scope],
    [label('deliverables'), p.deliverables],
    [label('successMetric'), p.successMetric],
    [label('successTarget'), p.successTarget],
    [label('acceptanceCriteria'), p.acceptanceCriteria],
    [label('stakeholders'), p.stakeholders],
  ];
  return (
    <div className="panel brief">
      <div className="brief-facts">
        <div>
          <span>{t('manager')}</span>
          <strong>{p.managerName ?? '-'}</strong>
        </div>
        <div>
          <span>{t('sponsor')}</span>
          <strong>{p.sponsor || '-'}</strong>
        </div>
        <div>
          <span>{t('department')}</span>
          <strong>{deptName(dept(p.departmentId), lang)}</strong>
        </div>
        <div>
          <span>{t('priority')}</span>
          <strong>{t(`priority_${p.priority}`)}</strong>
        </div>
      </div>
      <dl className="brief-list">
        {rows
          .filter(([, v]) => v && v.trim())
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
