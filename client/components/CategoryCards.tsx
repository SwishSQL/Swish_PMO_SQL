import { useState } from 'react';
import { Briefcase, Buildings, CheckSquare, TreeStructure } from '@phosphor-icons/react';
import type { Capability, Health, MilestoneRow, ProjectSummary } from '../../shared/types';
import { progressKpi } from '../../shared/kpi';
import { addDays } from '../../shared/dates';
import { useApp } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { openTask } from './OpenTask';

// The portfolio cut by the roles this person holds: the projects they manage, those where they own milestones,
// those under the programs and portfolios they run, and those of the department they head. Each card shows its
// own progress; picking one narrows the summary and the list below to it.

export type Category = 'all' | 'mgr' | 'ms' | 'prg' | 'dep';

/** Ahmed Hafez sees the cards first; everyone else keeps the page as it was until it is rolled out. */
export const CATEGORY_PREVIEW_USERS = new Set([171]);

export function categorySets(data: ProjectSummary[], plan: Capability[], milestones: MilestoneRow[] | null, me: number, headOf: Set<number>) {
  const mine = (milestones ?? []).filter((m) => m.mine);
  const msProjects = new Set(mine.map((m) => m.projectId));
  const planned = new Set<number>();
  for (const c of plan)
    for (const d of c.dimensions) if (c.managerUserId === me || d.managerUserId === me) for (const i of d.initiatives) planned.add(i.id);
  return {
    mgr: new Set(data.filter((p) => p.managerId === me).map((p) => p.id)),
    ms: new Set(data.filter((p) => msProjects.has(p.id)).map((p) => p.id)),
    prg: new Set(data.filter((p) => p.initiativeId != null && planned.has(p.initiativeId)).map((p) => p.id)),
    dep: new Set(data.filter((p) => headOf.has(p.departmentId)).map((p) => p.id)),
  };
}

const ICON = { mgr: Briefcase, ms: CheckSquare, prg: TreeStructure, dep: Buildings };
const BAR: Partial<Record<Health, string>> = { on_track: 'var(--ok)', at_risk: 'var(--warn)', off_track: 'var(--bad)' };

export function CategoryCards({
  data,
  sets,
  milestones,
  value,
  onChange,
}: {
  data: ProjectSummary[];
  sets: Record<Exclude<Category, 'all'>, Set<number>>;
  milestones: MilestoneRow[] | null;
  value: Category;
  onChange: (c: Category) => void;
}) {
  const { meta } = useApp();
  const { t } = useT();
  const today = meta.today;
  const keys = (['mgr', 'ms', 'prg', 'dep'] as const).filter((k) => sets[k].size > 0);
  if (!keys.length) return null;
  return (
    <div className="cat-cards" role="group" aria-label={t('cat_label')}>
      {keys.map((k) => {
        const Icon = ICON[k];
        const open = data.filter((p) => sets[k].has(p.id) && p.health !== 'done');
        const { actual } = progressKpi(open, today);
        const h = (x: Health) => open.filter((p) => p.health === x).length;
        const worst: Health = h('off_track') ? 'off_track' : h('at_risk') ? 'at_risk' : 'on_track';
        let big: string;
        let sub: string;
        let fill: number;
        if (k === 'ms') {
          const mine = (milestones ?? []).filter((m) => m.mine && !m.notRequired && m.status !== 'cancelled' && m.projectHealth !== 'done');
          const done = mine.filter((m) => m.status === 'done').length;
          const openMs = mine.filter((m) => m.status !== 'done');
          const overdue = openMs.filter((m) => m.date < today).length;
          const soon = openMs.filter((m) => m.date >= today && m.date <= addDays(today, 14)).length;
          big = `${done}/${mine.length}`;
          fill = mine.length ? Math.round((done / mine.length) * 100) : 0;
          sub = t('cat_msLine', { open: openMs.length, overdue, soon, n: new Set(mine.map((m) => m.projectId)).size });
        } else {
          big = `${actual}%`;
          fill = actual;
          sub = [
            h('on_track') ? t('cat_onTrack', { n: h('on_track') }) : '',
            h('at_risk') ? t('cat_atRisk', { n: h('at_risk') }) : '',
            h('off_track') ? t('cat_delayed', { n: h('off_track') }) : '',
          ]
            .filter(Boolean)
            .join(' · ') || t('cat_noOpen');
        }
        const on = value === k;
        return (
          <button key={k} type="button" className="cat-card" aria-pressed={on} onClick={() => onChange(on ? 'all' : k)}>
            <span className="cat-head">
              <Icon size={15} aria-hidden />
              {t(`cat_${k}` as never)}
            </span>
            <span className="cat-big">
              <strong className="num">{big}</strong>
              <span className="kpi-label">{k === 'ms' ? t('cat_done') : t('cat_projects', { n: open.length })}</span>
            </span>
            <span className="cat-bar">
              <i style={{ width: `${fill}%`, background: k === 'ms' ? 'var(--ink)' : BAR[worst] }} />
            </span>
            <span className="kpi-label">{sub}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The milestones this person owns in one project, nearest open first, two shown and the rest folded. */
export function MyMilestonesCell({ items }: { items: MilestoneRow[] }) {
  const { meta } = useApp();
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const today = meta.today;
  if (!items.length) return <span className="muted">-</span>;
  const sorted = [...items].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.date.localeCompare(b.date));
  const shown = open ? sorted : sorted.slice(0, 2);
  const openCount = items.filter((m) => m.status !== 'done').length;
  const color = (m: MilestoneRow) =>
    m.status === 'done' ? 'var(--ok)' : m.date < today ? 'var(--bad)' : m.status === 'in_progress' ? 'var(--accent)' : 'var(--line-strong)';
  return (
    <div className="my-ms" onClick={(e) => e.stopPropagation()}>
      <div className="kpi-label">{t('cat_msCount', { n: items.length, open: openCount })}</div>
      {shown.map((m) => (
        <button key={m.id} type="button" className="my-ms-item" onClick={() => openTask(m.projectId, m.id)} title={m.name}>
          <i style={{ background: color(m) }} aria-hidden />
          <span>
            {m.code && <strong>{m.code} </strong>}
            {m.name}
            <span className="kpi-label" style={{ color: m.status !== 'done' && m.date < today ? 'var(--bad)' : undefined }}> · {fmtDate(m.date, lang)}</span>
          </span>
        </button>
      ))}
      {sorted.length > 2 && (
        <button type="button" className="my-ms-more" onClick={() => setOpen(!open)}>
          {open ? t('cat_showLess') : t('cat_more', { n: sorted.length - 2 })}
        </button>
      )}
    </div>
  );
}
