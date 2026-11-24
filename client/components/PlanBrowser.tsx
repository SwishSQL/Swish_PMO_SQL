import { useEffect, useRef, useState } from 'react';
import { ArrowSquareOut, CaretRight, FileArrowUp, LinkSimple, PencilSimple, Plus, Sparkle, WarningCircle } from '@phosphor-icons/react';
import type { Capability, Health, Initiative, PlanLink, ProjectSummary } from '../../shared/types';
import { api } from '../api';
import { navigate, useApp, useToast } from '../lib/app';
import { NewProjectDialog, presetFrom } from './NewProject';
import { AiProjectDialog } from './AiProject';
import { useT } from '../lib/i18n';
import { fmtDate, projectName } from '../lib/format';
import { spotlight, stagger } from '../lib/motion';
import { Dialog, HealthBadge, Meter } from './ui';

// The Portfolio, the way the PMO's Transformation Capabilities workbook reads: Capability > Dimension > plan
// project > the projects of the system that deliver it > the project itself.

export type Level = { kind: 'root' } | { kind: 'capability'; id: number } | { kind: 'dimension'; id: number } | { kind: 'initiative'; id: number };

export function parseLevel(path: string[]): Level {
  const [, k, raw] = path;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { kind: 'root' };
  if (k === 'c') return { kind: 'capability', id };
  if (k === 'd') return { kind: 'dimension', id };
  if (k === 'i') return { kind: 'initiative', id };
  return { kind: 'root' };
}

const HEALTH_COLOR: Record<Health, string> = {
  on_track: 'var(--ok)',
  at_risk: 'var(--warn)',
  off_track: 'var(--bad)',
  not_started: 'var(--line-strong)',
  done: 'var(--ink-2)',
};

/** The projects of the system under a set of plan projects. */
export function projectsOf(inits: Initiative[], byId: Map<number, ProjectSummary>): ProjectSummary[] {
  return inits.flatMap((i) => i.projectIds.map((id) => byId.get(id)).filter((p): p is ProjectSummary => Boolean(p)));
}

/** Where the person is in the plan, as a trail of links. */
export function Trail({ plan, level }: { plan: Capability[]; level: Level }) {
  const { t } = useT();
  const where = locate(plan, level);
  const parts: { label: string; href: string }[] = [{ label: t('portfolio'), href: '#/portfolio' }];
  if (where.capability) parts.push({ label: where.capability.name, href: `#/portfolio/c/${where.capability.id}` });
  if (where.dimension) parts.push({ label: where.dimension.name, href: `#/portfolio/d/${where.dimension.id}` });
  if (where.initiative) parts.push({ label: where.initiative.name, href: `#/portfolio/i/${where.initiative.id}` });
  return (
    <nav className="plan-trail" aria-label={t('planTrail')}>
      {parts.map((p, i) => (
        <span key={p.href}>
          {i > 0 && <CaretRight size={12} aria-hidden className="plan-trail-sep" />}
          {i === parts.length - 1 ? <span aria-current="page">{p.label}</span> : <a href={p.href}>{p.label}</a>}
        </span>
      ))}
    </nav>
  );
}

export function locate(plan: Capability[], level: Level) {
  let capability: Capability | undefined;
  let dimension: Capability['dimensions'][number] | undefined;
  let initiative: Initiative | undefined;
  for (const c of plan)
    for (const d of c.dimensions) {
      if (level.kind === 'capability' && c.id === level.id) capability = c;
      if (level.kind === 'dimension' && d.id === level.id) ((capability = c), (dimension = d));
      for (const i of d.initiatives) if (level.kind === 'initiative' && i.id === level.id) ((capability = c), (dimension = d), (initiative = i));
    }
  return { capability, dimension, initiative };
}

/** The plan projects in reach of a level (all of them at the top). */
export function initiativesAt(plan: Capability[], level: Level): Initiative[] {
  const where = locate(plan, level);
  if (where.initiative) return [where.initiative];
  if (where.dimension) return where.dimension.initiatives;
  if (where.capability) return where.capability.dimensions.flatMap((d) => d.initiatives);
  return plan.flatMap((c) => c.dimensions.flatMap((d) => d.initiatives));
}

/** One card: a capability or a dimension, with how far its projects have got. */
function GroupCard({ title, sub, inits, byId, href, i }: { title: string; sub: string; inits: Initiative[]; byId: Map<number, ProjectSummary>; href: string; i: number }) {
  const { t } = useT();
  const projects = projectsOf(inits, byId);
  const started = inits.filter((x) => x.projectIds.some((id) => byId.has(id))).length;
  const progress = projects.length ? Math.round(projects.reduce((s, p) => s + p.progress, 0) / projects.length) : 0;
  const counts = (['on_track', 'at_risk', 'off_track', 'not_started', 'done'] as Health[]).map((h) => [h, projects.filter((p) => p.health === h).length] as const);
  return (
    <a className="plan-card spotlight enter" href={href} style={stagger(i)} onPointerMove={spotlight}>
      <div className="plan-card-top">
        <strong className="plan-card-title">{title}</strong>
        <CaretRight size={16} aria-hidden className="plan-card-go" />
      </div>
      <div className="muted plan-card-sub">{sub}</div>
      <div className="plan-card-figures">
        <div>
          <span className="num plan-card-big">{started}</span>
          <span className="muted">/{inits.length}</span>
          <div className="muted plan-card-label">{t('planStarted')}</div>
        </div>
        <div>
          <span className="num plan-card-big">{projects.length ? `${progress}%` : '-'}</span>
          <div className="muted plan-card-label">{t('planProgress')}</div>
        </div>
      </div>
      {projects.length > 0 ? (
        <div className="health-strip plan-card-strip" role="img" aria-label={counts.map(([h, n]) => `${t(`health_${h}`)} ${n}`).join(', ')}>
          {counts
            .filter(([, n]) => n > 0)
            .map(([h, n]) => (
              <span key={h} style={{ flex: n, background: HEALTH_COLOR[h] }} />
            ))}
        </div>
      ) : (
        <div className="plan-card-strip plan-card-empty muted">{t('planNotStarted')}</div>
      )}
    </a>
  );
}

/** The capabilities, or the dimensions of one capability, as cards. */
export function GroupGrid({ plan, level, byId, query }: { plan: Capability[]; level: Level; byId: Map<number, ProjectSummary>; query: string }) {
  const { meta } = useApp();
  const { t } = useT();
  const q = query.trim().toLowerCase();
  const hit = (name: string, inits: Initiative[]) => !q || name.toLowerCase().includes(q) || inits.some((i) => i.name.toLowerCase().includes(q));
  if (level.kind === 'root') {
    return (
      <div className="plan-grid">
        {plan
          .filter((c) => hit(c.name, c.dimensions.flatMap((d) => d.initiatives)))
          .map((c, i) => {
            const inits = c.dimensions.flatMap((d) => d.initiatives);
            return <GroupCard key={c.id} i={i} title={c.name} sub={`${t('planCapabilitySub', { d: c.dimensions.length, p: inits.length })}${c.managerUserId ? ` · ${meta.users.find((u) => u.id === c.managerUserId)?.name ?? ''}` : ''}`} inits={inits} byId={byId} href={`#/portfolio/c/${c.id}`} />;
          })}
      </div>
    );
  }
  const cap = locate(plan, level).capability;
  if (!cap) return null;
  return (
    <div className="plan-grid">
      {cap.dimensions
        .filter((d) => hit(d.name, d.initiatives))
        .map((d, i) => (
          <GroupCard key={d.id} i={i} title={d.name} sub={`${t('planDimensionSub', { p: d.initiatives.length })}${d.managerUserId ? ` · ${meta.users.find((u) => u.id === d.managerUserId)?.name ?? ''}` : ''}`} inits={d.initiatives} byId={byId} href={`#/portfolio/d/${d.id}`} />
        ))}
    </div>
  );
}

/**
 * A plan project with no project yet: a popup says so, shows what the workbook knows, and starts its project
 * with the assistant or by hand, under the same name and linked to it. Its own page stays one link away.
 */
export function EmptyPlanDialog({ it, onClose, showDetails = true }: { it: Initiative; onClose: () => void; showDetails?: boolean }) {
  const { t } = useT();
  const { meta, canCreateIn, can } = useApp();
  const [how, setHow] = useState<'ai' | 'manual' | null>(null);
  // A project manager starts a plan project nobody has started yet (the plan shows them only those, and theirs).
  const mayCreate = meta.departments.some((d) => canCreateIn(d.id)) || can('projects.start_plan');
  const done = (id: number) => {
    setHow(null);
    onClose();
    navigate(`/projects/${id}/plan`);
  };
  // Closing the form closes the popup as well: going back to the choice looked like the close button did nothing.
  if (how === 'ai') return <AiProjectDialog preset={presetFrom(it)} onClose={onClose} onCreated={done} />;
  if (how === 'manual') return <NewProjectDialog preset={presetFrom(it)} onClose={onClose} onCreated={done} />;
  const facts: [string, string | null][] = [
    [t('manager'), it.owner],
    [t('planOutcome'), it.outcome],
    [t('planKpi'), it.outcomeKpi],
    [t('planTarget'), it.target],
    [t('planTargetCompletion'), it.targetCompletion],
  ];
  return (
    <Dialog
      title={it.name}
      onClose={onClose}
      width={560}
      footer={
        <>
          {showDetails && (
            <a className="btn btn-ghost" href={`#/portfolio/i/${it.id}`} onClick={onClose} style={{ marginInlineEnd: 'auto' }}>
              {t('planViewDetails')}
            </a>
          )}
          {mayCreate && (
            <>
              <button className="btn" onClick={() => setHow('manual')}>
                <PencilSimple size={15} aria-hidden />
                {t('planCreateManual')}
              </button>
              <button className="btn btn-primary" onClick={() => setHow('ai')}>
                <Sparkle size={15} weight="fill" aria-hidden />
                {t('planCreateAi')}
              </button>
            </>
          )}
        </>
      }
    >
      <p className="empty-plan-note">
        <WarningCircle size={18} weight="fill" aria-hidden />
        <span>{mayCreate ? t('planEmptyNote') : t('planEmptyAskHead')}</span>
      </p>
      <dl className="plan-fields" style={{ marginTop: 12 }}>
        {facts
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd dir="auto">{v}</dd>
            </div>
          ))}
      </dl>
    </Dialog>
  );
}

/** The Create project button of an empty plan project: opens the same popup. */
function StartProject({ it, big }: { it: Initiative; big?: boolean }) {
  const { t } = useT();
  const { meta, canCreateIn, can } = useApp();
  const [open, setOpen] = useState(false);
  if (!meta.departments.some((d) => canCreateIn(d.id)) && !can('projects.start_plan')) return null;
  return (
    <>
      <button className={`btn ${big ? 'btn-primary' : 'btn-sm'}`} onClick={(e) => (e.preventDefault(), setOpen(true))}>
        <Plus size={14} weight="bold" aria-hidden />
        {t('planStartProject')}
      </button>
      {open && <EmptyPlanDialog it={it} onClose={() => setOpen(false)} showDetails={!big} />}
    </>
  );
}

/** The plan projects of a dimension, each with the system's projects that deliver it. */
export function InitiativeList({ inits, byId, query }: { inits: Initiative[]; byId: Map<number, ProjectSummary>; query: string }) {
  const { t, lang } = useT();
  const q = query.trim().toLowerCase();
  const shown = inits.filter((i) => !q || i.name.toLowerCase().includes(q) || i.projectIds.some((id) => (byId.get(id)?.name ?? '').toLowerCase().includes(q)));
  const [emptyOpen, setEmptyOpen] = useState<Initiative | null>(null);
  return (
    <div className="plan-list">
      {emptyOpen && <EmptyPlanDialog it={emptyOpen} onClose={() => setEmptyOpen(null)} />}
      {shown.map((it, n) => {
        const projects = projectsOf([it], byId);
        return (
          <div key={it.id} className="panel plan-item enter" style={stagger(n)}>
            <div className="plan-item-head">
              <a
                href={`#/portfolio/i/${it.id}`}
                className="plan-item-title"
                onClick={(e) => {
                  if (projects.length > 0) return;
                  e.preventDefault();
                  setEmptyOpen(it);
                }}
              >
                {it.name}
              </a>
              <div className="plan-item-tags">
                {it.status && <span className="tag">{it.status}</span>}
                {it.priority && <span className="tag">{it.priority}</span>}
                {it.owner && <span className="tag">{it.owner}</span>}
                {it.targetCompletion && <span className="tag num">{it.targetCompletion}</span>}
                {projects.length === 0 && <span className="tag muted">{t('planNotStarted')}</span>}
                {projects.length === 0 && <StartProject it={it} />}
              </div>
            </div>
            {projects.length > 0 && (
              <ul className="plan-projects">
                {projects.map((p) => (
                  <li key={p.id}>
                    <a href={`#/projects/${p.id}/plan`}>
                      <span className="code">{p.code}</span>
                      <span className="plan-project-name">{projectName(p, lang)}</span>
                    </a>
                    <HealthBadge health={p.health} />
                    <span className="num">{p.progress}%</span>
                    <Meter value={p.progress} />
                    <span className="num muted">{fmtDate(p.endDate, lang)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {shown.length === 0 && <div className="muted">{t('noMatchTitle')}</div>}
    </div>
  );
}

/** One plan project: the workbook's columns, and the system's projects under it. */
export function InitiativeDetail({ it, byId, projects, onLinked }: { it: Initiative; byId: Map<number, ProjectSummary>; projects: ProjectSummary[]; onLinked: () => void }) {
  const { t, lang } = useT();
  const { can } = useApp();
  const toast = useToast();
  const [adding, setAdding] = useState<number | ''>('');
  const linked = projectsOf([it], byId);
  const fields: [string, string | null][] = [
    [t('planType'), it.type],
    [t('status'), it.status],
    [t('priority'), it.priority],
    [t('manager'), it.owner],
    [t('planOutcome'), it.outcome],
    [t('planCompletion'), it.completionCriteria],
    [t('planKpi'), it.outcomeKpi],
    [t('planBaseline'), it.baseline],
    [t('planTarget'), it.target],
    [t('start'), it.startDate],
    [t('planTargetCompletion'), it.targetCompletion],
    [t('planParent'), it.parentInitiative],
    [t('planDependency'), it.dependency],
  ];
  const link = async (projectId: number, initiativeId: number | null) => {
    try {
      await api.post('/api/transformation/links', { links: [{ projectId, initiativeId }] });
      setAdding('');
      onLinked();
      toast(t('saved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  return (
    <>
      <div className="panel plan-detail enter">
        <dl className="plan-fields">
          {fields.map(([k, v]) => (
            <div key={k} className={v ? '' : 'empty'}>
              <dt>{k}</dt>
              <dd dir="auto">{v || '-'}</dd>
            </div>
          ))}
        </dl>
      </div>
      <h2 className="plan-section">{t('planDeliveredBy', { n: linked.length })}</h2>
      {linked.length === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <p className="muted" style={{ margin: 0 }}>{t('planNoProjects')}</p>
          <StartProject it={it} big />
        </div>
      )}
      <ul className="plan-projects plan-projects-big">
        {linked.map((p) => (
          <li key={p.id}>
            <a href={`#/projects/${p.id}/plan`}>
              <span className="code">{p.code}</span>
              <span className="plan-project-name">{projectName(p, lang)}</span>
              <ArrowSquareOut size={13} aria-hidden />
            </a>
            <HealthBadge health={p.health} />
            <span className="num">{p.progress}%</span>
            <Meter value={p.progress} />
            <span className="num muted">{fmtDate(p.endDate, lang)}</span>
            {can('projects.edit_all') && (
              <button className="btn btn-ghost btn-sm" onClick={() => link(p.id, null)}>
                {t('planUnlink')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {can('projects.edit_all') && (
        <div className="plan-add">
          <select className="select" value={adding} aria-label={t('planLinkProject')} onChange={(e) => setAdding(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('planLinkProject')}</option>
            {projects
              .filter((p) => p.initiativeId !== it.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} {projectName(p, lang)}
                  {p.initiativeId ? ` (${t('planMoves')})` : ''}
                </option>
              ))}
          </select>
          <button className="btn btn-sm" disabled={!adding} onClick={() => adding && link(adding, it.id)}>
            <LinkSimple size={14} aria-hidden /> {t('planLink')}
          </button>
        </div>
      )}
    </>
  );
}

/** The PMO chooses, for each project, the plan project it belongs to (or none). Nothing is linked automatically. */
export function LinkDialog({ plan, onClose, onSaved }: { plan: Capability[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [rows, setRows] = useState<PlanLink[] | null>(null);
  const [chosen, setChosen] = useState<Record<number, number | ''>>({});
  const [busy, setBusy] = useState(false);
  // By default only the projects not linked yet: what is left to do. A project linked here stays in view until saved.
  const [onlyUnlinked, setOnlyUnlinked] = useState(true);
  useEffect(() => {
    api
      .get<PlanLink[]>('/api/transformation/links')
      .then((r) => {
        setRows(r);
        if (!r.some((x) => !x.initiativeId)) setOnlyUnlinked(false);
        setChosen(Object.fromEntries(r.map((x) => [x.projectId, x.initiativeId ?? ''])));
      })
      .catch((e) => toast((e as Error).message, 'bad'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changed = (rows ?? []).filter((r) => (chosen[r.projectId] || null) !== (r.initiativeId ?? null));
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ saved: number }>('/api/transformation/links', { links: changed.map((x) => ({ projectId: x.projectId, initiativeId: chosen[x.projectId] || null })) });
      toast(t('planLinksSaved', { n: r.saved }));
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'bad');
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('planLinkTitle')}
      onClose={onClose}
      width={980}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || changed.length === 0} onClick={save}>
            {t('planSaveLinks', { n: changed.length })}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        {t('planLinkHint')}
      </p>
      {rows && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, margin: '0 0 12px', fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyUnlinked} onChange={(e) => setOnlyUnlinked(e.target.checked)} />
          {t('planOnlyUnlinked', { n: rows.filter((r) => !r.initiativeId).length, all: rows.length })}
        </label>
      )}
      {!rows ? (
        <div className="skeleton" style={{ height: 240, borderRadius: 12 }} />
      ) : (
        <div className="table-wrap">
          <table className="table plan-link-table">
            <thead>
              <tr>
                <th>{t('project')}</th>
                <th>{t('planProject')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.filter((r) => !onlyUnlinked || !r.initiativeId).length === 0 && (
                <tr>
                  <td colSpan={2} className="muted">
                    {t('planAllLinked')}
                  </td>
                </tr>
              )}
              {rows.filter((r) => !onlyUnlinked || !r.initiativeId).map((r) => {
                const value = chosen[r.projectId] ?? '';
                return (
                  <tr key={r.projectId} className={(value || null) !== (r.initiativeId ?? null) ? 'plan-link-changed' : ''}>
                    <td>
                      <span className="code">{r.code}</span> <span dir="auto">{r.name}</span>
                    </td>
                    <td style={{ minWidth: 300 }}>
                      <select className="select" value={value} onChange={(e) => setChosen({ ...chosen, [r.projectId]: e.target.value ? Number(e.target.value) : '' })}>
                        <option value="">{t('planNotLinked')}</option>
                        {plan.map((c) =>
                          c.dimensions.map((d) => (
                            <optgroup key={d.id} label={`${c.name} › ${d.name}`}>
                              {d.initiatives.map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.name}
                                </option>
                              ))}
                            </optgroup>
                          )),
                        )}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

/** The PMO loads a new version of the Transformation Capabilities workbook. */
export function ImportPlanButton({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => input.current?.click()} title={t('planImportHint')}>
        <FileArrowUp size={15} aria-hidden /> {t('planImport')}
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          try {
            const data = await new Promise<string>((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
              r.onerror = () => reject(new Error(t('deliveryReadFailed')));
              r.readAsDataURL(f);
            });
            const r = await api.post<{ capabilities: number; dimensions: number; projects: number; added: number }>('/api/transformation/import', { data, name: f.name });
            toast(t('planImported', { c: r.capabilities, d: r.dimensions, p: r.projects, a: r.added }));
            onDone();
          } catch (err) {
            toast((err as Error).message, 'bad');
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

