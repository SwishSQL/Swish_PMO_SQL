import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import {
  ArrowLineLeft,
  ArrowLineRight,
  CaretDown,
  CaretRight,
  Crosshair,
  Diamond,
  FlagBanner,
  ListPlus,
  PencilSimple,
  PushPin,
  Trash,
} from '@phosphor-icons/react';
import type { Dependency, Task, User } from '../../shared/types';
import { addDays, diffDays, fromDay, toDay, weekday } from '../../shared/dates';
import { criticalPath, rollUp } from '../../shared/schedule';
import { useT } from '../lib/i18n';
import { fmtDate, fmtMonth, initials } from '../lib/format';
import { safeGet, safeSet, useApp } from '../lib/app';
import { useCalendar } from '../lib/calendar';
import { Segmented, useTooltip } from './ui';

export interface PlanState {
  tasks: Task[];
  dependencies: Dependency[];
}

type Zoom = 'week' | 'month' | 'quarter';
const DAY_W: Record<Zoom, number> = { week: 30, month: 13, quarter: 5.5 };
const ROW = 36;
const HEAD = 52;

interface Row {
  task: Task;
  depth: number;
  wbs: string;
  hasChildren: boolean;
}

interface Drag {
  id: number;
  mode: 'move' | 'resize' | 'link';
  x0: number;
  days: number;
  pointer?: { x: number; y: number };
}

interface Props {
  plan: PlanState;
  color: string;
  canEdit: boolean;
  today: string;
  users: Map<number, User>;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onOpen: (id: number) => void;
  onMove: (id: number, startDate: string, endDate: string) => void;
  onLink: (predecessorId: number, successorId: number) => void;
  onRename: (id: number, name: string) => void;
  onAdd: (kind: 'summary' | 'task' | 'milestone') => void;
  onIndent: (dir: 1 | -1) => void;
  onDelete: () => void;
  /** Phases and milestones need the project manager or the PMO. */
  canDelete: (task: Task) => boolean;
  /** The project has an approved baseline: milestones are added, moved or removed by change requests. */
  baselined?: boolean;
  /** The baseline command this person may run, if any: re-baseline (PMO) or baseline new items. */
  baseline: { label: string; onClick: () => void } | null;
  editingId: number | null;
  setEditingId: (id: number | null) => void;
}

/**
 * Month names that ride along while their month is in view. They follow the horizontal scroll, so
 * they keep that position to themselves: only these few labels redraw while scrolling, not the
 * whole plan (about two thousand elements for a long project).
 */
function MonthLabels({ months, d0, dayW, scroller }: { months: { start: number; end: number; label: string }[]; d0: number; dayW: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const [scrollX, setScrollX] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const on = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrollX(el.scrollLeft));
    };
    on();
    el.addEventListener('scroll', on, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', on);
    };
  }, [scroller]);
  return (
    <>
      {months.map((m) => (
        <g key={m.start}>
          <line x1={(m.start - d0) * dayW} x2={(m.start - d0) * dayW} y1={0} y2={HEAD} stroke="var(--line)" />
          <text x={Math.max((m.start - d0) * dayW, Math.min(scrollX, (m.end - d0 + 1) * dayW - 130)) + 8} y={18} fontSize={12} fontWeight={600} fill="var(--ink-2)">
            {(m.end - m.start + 1) * dayW > 70 ? m.label : ''}
          </text>
        </g>
      ))}
    </>
  );
}

export function Gantt(props: Props) {
  const { plan, color, canEdit, today, users, selectedId, onSelect, editingId, setEditingId } = props;
  const { t, lang } = useT();
  const cal = useCalendar();
  const { meta } = useApp();
  const [zoom, setZoomState] = useState<Zoom>(() => (safeGet('pmo.zoom') as Zoom) || 'month');
  const [showCritical, setShowCritical] = useState(true);
  const [showBaseline, setShowBaseline] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<SVGSVGElement>(null);
  const tip = useTooltip();
  const dayW = DAY_W[zoom];
  const setZoom = (z: Zoom) => {
    setZoomState(z);
    safeSet('pmo.zoom', z);
  };

  // While dragging, preview the move on a rolled-up copy of the plan.
  const tasks = useMemo(() => {
    if (!drag || drag.mode === 'link' || drag.days === 0) return plan.tasks;
    const moved = plan.tasks.map((tk) => {
      if (tk.id !== drag.id) return tk;
      if (drag.mode === 'move') return { ...tk, startDate: addDays(tk.startDate, drag.days), endDate: addDays(tk.endDate, drag.days) };
      const end = addDays(tk.endDate, drag.days);
      return { ...tk, endDate: end < tk.startDate ? tk.startDate : end };
    });
    return rollUp(moved);
  }, [plan.tasks, drag]);

  const rows = useMemo<Row[]>(() => {
    const kids = new Map<number | null, Task[]>();
    for (const tk of tasks) {
      const k = tk.parentId ?? null;
      kids.set(k, [...(kids.get(k) ?? []), tk]);
    }
    for (const l of kids.values()) l.sort((a, b) => a.sort - b.sort || a.id - b.id);
    const out: Row[] = [];
    const walk = (parent: number | null, depth: number, prefix: string) => {
      (kids.get(parent) ?? []).forEach((tk, i) => {
        const wbs = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
        const hasChildren = (kids.get(tk.id) ?? []).length > 0;
        out.push({ task: tk, depth, wbs, hasChildren });
        if (hasChildren && !collapsed.has(tk.id)) walk(tk.id, depth + 1, wbs);
      });
    };
    walk(null, 0, '');
    return out;
  }, [tasks, collapsed]);

  const crit = useMemo(() => criticalPath(tasks, plan.dependencies), [tasks, plan.dependencies]);

  // Time window: the plan plus breathing room, never shorter than ten weeks.
  const starts = tasks.map((tk) => tk.startDate).concat(today);
  const ends = tasks.map((tk) => tk.endDate).concat(today);
  const first = starts.reduce((a, b) => (a < b ? a : b));
  const last = ends.reduce((a, b) => (a > b ? a : b));
  const d0 = toDay(addDays(first, -(zoom === 'week' ? 4 : 10)));
  const d1 = Math.max(toDay(addDays(last, zoom === 'week' ? 10 : 24)), d0 + 70);
  const width = (d1 - d0 + 1) * dayW;
  const x = (iso: string) => (toDay(iso) - d0) * dayW;
  const height = Math.max(rows.length * ROW, 6 * ROW);
  const rowIndex = new Map(rows.map((r, i) => [r.task.id, i]));

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, x(addDays(today, -7)));
    // only on first paint and zoom changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  const scrollToday = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: Math.max(0, x(addDays(today, -7))), behavior: 'smooth' });
  };

  // ---- Pointer interactions ----
  const begin = (e: RPointerEvent, id: number, mode: Drag['mode']) => {
    if (!canEdit) return;
    // A finger on the chart scrolls it (the browser decides that at touchstart, so a drag could not work
    // anyway): a tap opens the milestone, whose panel has the date fields. Dragging is for mouse and pen.
    if (e.pointerType === 'touch') return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    onSelect(id);
    setDrag({ id, mode, x0: e.clientX, days: 0 });
  };
  const move = (e: RPointerEvent) => {
    if (!drag) return;
    if (drag.mode === 'link') {
      const r = bodyRef.current!.getBoundingClientRect();
      setDrag({ ...drag, pointer: { x: e.clientX - r.left, y: e.clientY - r.top } });
      return;
    }
    const days = Math.round((e.clientX - drag.x0) / dayW);
    if (days !== drag.days) setDrag({ ...drag, days });
  };
  const end = (e: RPointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.mode === 'link') {
      const r = bodyRef.current!.getBoundingClientRect();
      const i = Math.floor((e.clientY - r.top) / ROW);
      const target = rows[i]?.task;
      if (target && target.id !== d.id && target.kind !== 'summary') props.onLink(d.id, target.id);
      return;
    }
    if (d.days === 0) return;
    const tk = plan.tasks.find((x) => x.id === d.id)!;
    if (d.mode === 'move') props.onMove(tk.id, addDays(tk.startDate, d.days), addDays(tk.endDate, d.days));
    else {
      const endDate = addDays(tk.endDate, d.days);
      props.onMove(tk.id, tk.startDate, endDate < tk.startDate ? tk.startDate : endDate);
    }
  };

  // ---- Header scale ----
  const months: { start: number; end: number; label: string }[] = [];
  for (let d = d0; d <= d1; ) {
    const iso = fromDay(d);
    const [yy, mm] = iso.split('-').map(Number);
    const next = toDay(mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`);
    months.push({ start: d, end: Math.min(next - 1, d1), label: `${fmtMonth(iso, lang)} ${yy}` });
    d = next;
  }
  const ticks: { day: number; label: string; weekend: boolean }[] = [];
  for (let d = d0; d <= d1; d++) {
    const iso = fromDay(d);
    const wd = weekday(iso);
    if (zoom === 'week') ticks.push({ day: d, label: String(Number(iso.slice(8))), weekend: !cal.isWorkday(iso) });
    else if (wd === 0) ticks.push({ day: d, label: String(Number(iso.slice(8))), weekend: false });
  }
  const weekendBands =
    zoom === 'quarter'
      ? []
      : Array.from({ length: d1 - d0 + 1 }, (_, i) => d0 + i).filter((d) => weekday(fromDay(d)) === 5);
  // Official holidays in view, tinted and named on hover, at every zoom.
  const holidayBands = (meta.holidays ?? []).filter((h) => toDay(h.date) >= d0 && toDay(h.date) <= d1);

  const selected = plan.tasks.find((tk) => tk.id === selectedId) ?? null;
  // A task goes inside a milestone, so the Task button is there only while a milestone (or a task in one) is selected.
  const canAddTask =
    !!selected && (selected.kind === 'milestone' || (selected.kind === 'task' && plan.tasks.find((x) => x.id === selected.parentId)?.kind === 'milestone'));

  return (
    <div className="gantt">
      <div className="gantt-toolbar">
        {canEdit && (
          <>
            <button className="btn btn-sm" onClick={() => props.onAdd('summary')}>
              <FlagBanner size={15} aria-hidden />
              {t('addPhase')}
            </button>
            {canAddTask && (
              <button className="btn btn-sm" onClick={() => props.onAdd('task')} title={t('addTaskHint')}>
                <ListPlus size={15} aria-hidden />
                {t('addTask')}
              </button>
            )}
            <button className="btn btn-sm" disabled={props.baselined} title={props.baselined ? t('cr_lockedField') : undefined} onClick={() => props.onAdd('milestone')}>
              <Diamond size={15} aria-hidden />
              {t('addMilestone')}
            </button>
            <span className="sep" />
            <button className="btn btn-ghost btn-sm" disabled={!selected} onClick={() => selected && props.onOpen(selected.id)}>
              <PencilSimple size={15} aria-hidden />
              {t('edit')}
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" disabled={!selected} onClick={() => props.onIndent(-1)} aria-label={t('outdent')} title={t('outdent')}>
              <ArrowLineLeft size={16} />
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" disabled={!selected} onClick={() => props.onIndent(1)} aria-label={t('indent')} title={t('indent')}>
              <ArrowLineRight size={16} />
            </button>
            <button
              className="btn btn-ghost btn-sm btn-icon btn-danger"
              disabled={!selected || !props.canDelete(selected)}
              onClick={props.onDelete}
              aria-label={t('delete')}
              title={selected && !props.canDelete(selected) ? (props.baselined ? t('cr_lockedField') : t('deleteNeedsManager')) : t('delete')}
            >
              <Trash size={16} />
            </button>
            {props.baseline && (
              <>
                <span className="sep" />
                <button className="btn btn-ghost btn-sm" onClick={props.baseline.onClick}>
                  <PushPin size={15} aria-hidden />
                  {props.baseline.label}
                </button>
              </>
            )}
          </>
        )}
        <span className="spacer" />
        <label className="toggle">
          <input type="checkbox" checked={showCritical} onChange={(e) => setShowCritical(e.target.checked)} />
          {t('criticalPath')}
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} />
          {t('baseline')}
        </label>
        <button className="btn btn-ghost btn-sm" onClick={scrollToday}>
          <Crosshair size={15} aria-hidden />
          {t('today')}
        </button>
        <Segmented
          label="Zoom"
          value={zoom}
          onChange={setZoom}
          options={[
            { value: 'week', label: t('zoomWeek') },
            { value: 'month', label: t('zoomMonth') },
            { value: 'quarter', label: t('zoomQuarter') },
          ]}
        />
      </div>

      <div className="gantt-scroll" ref={scroller} dir="ltr">
        <div className="gantt-inner">
          {/* ---- Task sheet ---- */}
          <div className="gantt-grid" role="grid" aria-label={t('plan')} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            <div className="g-row g-head" role="row">
              <div />
              <div>{t('taskName')}</div>
              <div>{t('start')}</div>
              <div>{t('finish')}</div>
              <div className="num" title={t('workDaysHint')}>
                {t('days')}
              </div>
              <div className="num">%</div>
              <div />
            </div>
            {rows.map(({ task: tk, depth, wbs, hasChildren }) => {
              const isCrit = showCritical && crit.critical.has(tk.id);
              const owner = users.get(tk.assigneeId ?? -1);
              return (
                <div
                  key={tk.id}
                  role="row"
                  aria-selected={tk.id === selectedId}
                  className={`g-row ${tk.id === selectedId ? 'selected' : ''} ${tk.kind === 'summary' ? 'is-summary' : ''} ${tk.notRequired ? 'not-required' : ''}`}
                  tabIndex={0}
                  // Whoever cannot rename opens the task with a click: a team member on their own task, or a viewer.
                  onClick={() => {
                    onSelect(tk.id);
                    if (!canEdit) props.onOpen(tk.id);
                  }}
                  onDoubleClick={() => canEdit && setEditingId(tk.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter') props.onOpen(tk.id);
                    if (e.key === 'F2' && canEdit) setEditingId(tk.id);
                  }}
                >
                  <div className="g-num num">{wbs}</div>
                  <div className="g-name" style={{ paddingInlineStart: 6 + depth * 18 }}>
                    {hasChildren ? (
                      <button
                        className="caret"
                        aria-label={collapsed.has(tk.id) ? 'Expand' : 'Collapse'}
                        aria-expanded={!collapsed.has(tk.id)}
                        onClick={(e) => {
                          e.stopPropagation();
                          const n = new Set(collapsed);
                          if (n.has(tk.id)) n.delete(tk.id);
                          else n.add(tk.id);
                          setCollapsed(n);
                        }}
                      >
                        {collapsed.has(tk.id) ? <CaretRight size={12} weight="bold" style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} /> : <CaretDown size={12} weight="bold" />}
                      </button>
                    ) : (
                      <span className="caret-gap" />
                    )}
                    {tk.kind === 'milestone' && <Diamond size={12} weight="fill" style={{ flex: 'none', color: 'var(--ink-2)' }} aria-hidden />}
                    {editingId === tk.id ? (
                      <input
                        autoFocus
                        defaultValue={tk.name}
                        aria-label={t('taskName')}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={(e) => e.target.select()}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          setEditingId(null);
                          if (v && v !== tk.name) props.onRename(tk.id, v);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                    ) : (
                      <span className="label" title={tk.name}>
                        {tk.name}
                      </span>
                    )}
                    {tk.notRequired && <span className="flag-chip" style={{ flex: 'none' }}>{t('notRequired')}</span>}
                    {isCrit && <span className="crit-dot" title={t('criticalPath')} />}
                  </div>
                  <div className="num ink-2">{fmtDate(tk.startDate, lang)}</div>
                  <div className="num ink-2">{fmtDate(tk.endDate, lang)}</div>
                  <div className="num ink-2">{tk.kind === 'milestone' ? 0 : cal.workdays(tk.startDate, tk.endDate)}</div>
                  <div className="num">{tk.progress}</div>
                  <div style={{ padding: 0, display: 'grid', placeItems: 'center' }}>
                    {(owner?.name ?? tk.ownerName) && (
                      <span className="avatar avatar-sm" title={[owner?.name ?? tk.ownerName, tk.coOwners].filter(Boolean).join(' + ')}>
                        {initials(owner?.name ?? tk.ownerName ?? '')}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ---- Timeline ---- */}
          <div className={`gantt-chart ${drag?.mode === 'link' ? 'linking' : ''}`} style={{ width }}>
            <div className="gc-head" style={{ height: HEAD, borderBottom: '1px solid var(--line-strong)' }}>
              <svg width={width} height={HEAD} aria-hidden>
                <MonthLabels months={months} d0={d0} dayW={dayW} scroller={scroller} />
                <line x1={0} x2={width} y1={26} y2={26} stroke="var(--line)" />
                {holidayBands.map((h) => (
                  <rect key={h.date} className="g-holiday" x={(toDay(h.date) - d0) * dayW} y={27} width={Math.max(dayW, 3)} height={HEAD - 27} fill="var(--warn-soft)">
                    <title>{`${fmtDate(h.date, lang)} · ${(lang === 'ar' && h.nameAr) || h.name}`}</title>
                  </rect>
                ))}
                {ticks.map((tk) => (
                  <g key={tk.day}>
                    {zoom !== 'week' && <line x1={(tk.day - d0) * dayW} x2={(tk.day - d0) * dayW} y1={26} y2={HEAD} stroke="var(--line)" />}
                    <text
                      x={(tk.day - d0) * dayW + (zoom === 'week' ? dayW / 2 : 4)}
                      y={43}
                      fontSize={11}
                      textAnchor={zoom === 'week' ? 'middle' : 'start'}
                      fill={tk.weekend ? 'var(--ink-3)' : 'var(--ink-2)'}
                      className="num"
                    >
                      {zoom === 'quarter' ? '' : tk.label}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
            <svg
              ref={bodyRef}
              width={width}
              height={height}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={() => setDrag(null)}
              onClick={(e) => {
                if (e.target === e.currentTarget) onSelect(null);
                // On a touch screen there is no double-click: a tap on a row opens its panel.
                if (!window.matchMedia('(pointer: coarse)').matches) return;
                const r = bodyRef.current!.getBoundingClientRect();
                const hit = rows[Math.floor((e.clientY - r.top) / ROW)]?.task;
                if (hit) props.onOpen(hit.id);
              }}
              onDoubleClick={(e) => {
                const r = bodyRef.current!.getBoundingClientRect();
                const hit = rows[Math.floor((e.clientY - r.top) / ROW)]?.task;
                if (hit) props.onOpen(hit.id);
              }}
              style={{ touchAction: drag ? 'none' : 'pan-x pan-y' }}
            >
              <defs>
                <marker id="g-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--ink-3)" />
                </marker>
                <marker id="g-arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--bad)" />
                </marker>
              </defs>
              {weekendBands.map((d) => (
                <rect key={d} x={(d - d0) * dayW} y={0} width={dayW * 2} height={height} fill="var(--surface-2)" />
              ))}
              {holidayBands.map((h) => (
                <rect key={h.date} x={(toDay(h.date) - d0) * dayW} y={0} width={Math.max(dayW, 2)} height={height} fill="var(--warn-soft)" pointerEvents="none" />
              ))}
              {zoom !== 'week' &&
                ticks.map((tk) => <line key={tk.day} x1={(tk.day - d0) * dayW} x2={(tk.day - d0) * dayW} y1={0} y2={height} stroke="var(--line)" strokeOpacity={0.6} />)}
              {rows.map((r, i) => (
                <rect
                  key={r.task.id}
                  x={0}
                  y={i * ROW}
                  width={width}
                  height={ROW}
                  fill={r.task.id === selectedId ? 'var(--accent-soft)' : 'transparent'}
                  onClick={() => onSelect(r.task.id)}
                />
              ))}
              {rows.map((_, i) => (
                <line key={i} x1={0} x2={width} y1={(i + 1) * ROW - 0.5} y2={(i + 1) * ROW - 0.5} stroke="var(--line)" strokeOpacity={0.55} pointerEvents="none" />
              ))}

              {/* Dependency arrows */}
              {plan.dependencies.map((d) => {
                const pi = rowIndex.get(d.predecessorId);
                const si = rowIndex.get(d.successorId);
                if (pi === undefined || si === undefined) return null;
                const p = rows[pi].task;
                const s = rows[si].task;
                const isCrit = showCritical && crit.critical.has(p.id) && crit.critical.has(s.id);
                const px = p.kind === 'milestone' ? x(p.startDate) + dayW / 2 + 7 : x(addDays(p.endDate, 1));
                const py = pi * ROW + ROW / 2;
                const sx = s.kind === 'milestone' ? x(s.startDate) + dayW / 2 - 7 : x(s.startDate);
                const sy = si * ROW + ROW / 2;
                const down = sy > py ? 1 : -1;
                const path =
                  sx - px >= 14
                    ? `M${px},${py} H${px + 7} V${sy} H${sx - 1}`
                    : `M${px},${py} H${px + 7} V${py + (down * ROW) / 2} H${sx - 9} V${sy} H${sx - 1}`;
                return (
                  <path
                    key={d.id}
                    className="gc-arrow"
                    d={path}
                    fill="none"
                    stroke={isCrit ? 'var(--bad)' : 'var(--ink-3)'}
                    strokeWidth={isCrit ? 1.6 : 1.2}
                    markerEnd={`url(#${isCrit ? 'g-arrow-crit' : 'g-arrow'})`}
                    pointerEvents="none"
                  />
                );
              })}

              {/* Bars */}
              {rows.map(({ task: tk }, i) => {
                const cy = i * ROW + ROW / 2;
                const xs = x(tk.startDate);
                const xe = x(addDays(tk.endDate, 1));
                const isCrit = showCritical && crit.critical.has(tk.id);
                const owner = users.get(tk.assigneeId ?? -1);
                const late = tk.status !== 'done' && tk.status !== 'cancelled' && tk.progress < 100 && tk.endDate < today;
                const baseline =
                  showBaseline && tk.baselineStart && tk.baselineEnd ? (
                    <rect
                      x={x(tk.baselineStart)}
                      y={cy + 7}
                      width={Math.max(3, x(addDays(tk.baselineEnd, 1)) - x(tk.baselineStart))}
                      height={4}
                      rx={2}
                      fill="var(--ink-3)"
                      opacity={0.45}
                      pointerEvents="none"
                    />
                  ) : null;
                const tooltip = (e: React.MouseEvent) =>
                  tip.show(
                    e,
                    <>
                      <strong>{tk.name}</strong>
                      <div>
                        {fmtDate(tk.startDate, lang)} - {fmtDate(tk.endDate, lang)}. {tk.progress}%
                      </div>
                      {tk.kind !== 'summary' && (
                        <div className="tt-dim">
                          {crit.critical.has(tk.id) ? t('onCriticalPath') : t('floatDays', { n: Math.max(0, crit.floatDays.get(tk.id) ?? 0) })}
                        </div>
                      )}
                      {tk.baselineEnd && tk.baselineEnd !== tk.endDate && (
                        <div className="tt-dim">
                          {diffDays(tk.baselineEnd, tk.endDate) > 0
                            ? t('slipDays', { n: diffDays(tk.baselineEnd, tk.endDate) })
                            : t('earlyDays', { n: -diffDays(tk.baselineEnd, tk.endDate) })}
                        </div>
                      )}
                    </>,
                  );

                if (tk.kind === 'summary') {
                  // A phase the project does not need has no bar: the row says so.
                  if (tk.notRequired) return <g key={tk.id} onClick={() => onSelect(tk.id)} />;
                  return (
                    <g key={tk.id} className="gc-grow" style={{ ['--i' as string]: i }} onMouseMove={tooltip} onMouseLeave={tip.hide} onClick={() => onSelect(tk.id)}>
                      {baseline}
                      <rect x={xs} y={cy - 7} width={Math.max(2, xe - xs)} height={7} fill="var(--ink)" rx={1} />
                      <rect x={xs} y={cy - 7} width={Math.max(0, (xe - xs) * (tk.progress / 100))} height={7} fill={color} rx={1} />
                      <path d={`M${xs},${cy} l0,5 l6,-5 z`} fill="var(--ink)" />
                      <path d={`M${xe},${cy} l0,5 l-6,-5 z`} fill="var(--ink)" />
                    </g>
                  );
                }

                if (tk.kind === 'milestone') {
                  const mx = xs + dayW / 2;
                  return (
                    <g
                      key={tk.id}
                      className={`gc-task gc-pop ${tk.id === selectedId ? 'selected' : ''} ${drag?.id === tk.id ? 'dragging' : ''}`}
                      style={{ ['--i' as string]: i }}
                      onMouseMove={tooltip}
                      onMouseLeave={tip.hide}
                    >
                      {showBaseline && tk.baselineStart && tk.baselineStart !== tk.startDate && (
                        <g pointerEvents="none">
                          {/* From the committed date to where it sits now. */}
                          <line
                            x1={x(tk.baselineStart) + dayW / 2}
                            x2={mx}
                            y1={cy}
                            y2={cy}
                            stroke={tk.startDate > tk.baselineStart ? 'var(--bad)' : 'var(--ok)'}
                            strokeOpacity={0.55}
                            strokeWidth={2}
                            strokeDasharray="3 3"
                          />
                          <path
                            d={`M${x(tk.baselineStart) + dayW / 2},${cy - 5} l5,5 l-5,5 l-5,-5 z`}
                            fill="none"
                            stroke="var(--ink-3)"
                            strokeDasharray="2 2"
                          />
                        </g>
                      )}
                      <path
                        className="gc-bar"
                        d={`M${mx},${cy - 8} l8,8 l-8,8 l-8,-8 z`}
                        fill={tk.status === 'done' ? 'var(--ink)' : 'var(--surface)'}
                        stroke={isCrit ? 'var(--bad)' : late ? 'var(--bad)' : 'var(--ink)'}
                        strokeWidth={2}
                        opacity={tk.status === 'cancelled' ? 0.3 : 1}
                        onPointerDown={(e) => begin(e, tk.id, 'move')}
                      />
                      <text x={mx + 14} y={cy + 4} fontSize={11.5} fill="var(--ink-2)" pointerEvents="none">
                        {fmtDate(tk.startDate, lang)}
                      </text>
                      {canEdit && (
                        <circle className="gc-link" cx={mx + 11} cy={cy - 9} r={4} fill="var(--surface)" stroke="var(--ink-2)" strokeWidth={1.5} onPointerDown={(e) => begin(e, tk.id, 'link')} />
                      )}
                    </g>
                  );
                }

                const w = Math.max(dayW, xe - xs);
                return (
                  <g
                    key={tk.id}
                    className={`gc-task gc-grow ${tk.id === selectedId ? 'selected' : ''} ${drag?.id === tk.id ? 'dragging' : ''}`}
                    style={{ ['--i' as string]: i }}
                    onMouseMove={tooltip}
                    onMouseLeave={tip.hide}
                  >
                    {baseline}
                    <rect
                      className="gc-bar"
                      x={xs}
                      y={cy - 9}
                      width={w}
                      height={16}
                      rx={4}
                      fill={color}
                      fillOpacity={0.28}
                      stroke={isCrit ? 'var(--bad)' : 'none'}
                      strokeWidth={isCrit ? 1.5 : 0}
                      onPointerDown={(e) => begin(e, tk.id, 'move')}
                    />
                    <rect x={xs} y={cy - 9} width={w * (tk.progress / 100)} height={16} rx={4} fill={color} pointerEvents="none" />
                    {canEdit && <rect className="gc-resize" x={xs + w - 6} y={cy - 9} width={8} height={16} fill="transparent" onPointerDown={(e) => begin(e, tk.id, 'resize')} />}
                    {canEdit && (
                      <circle className="gc-link" cx={xs + w + 9} cy={cy - 1} r={4} fill="var(--surface)" stroke="var(--ink-2)" strokeWidth={1.5} onPointerDown={(e) => begin(e, tk.id, 'link')} />
                    )}
                    <text x={xs + w + (canEdit ? 18 : 8)} y={cy + 3} fontSize={11.5} fill={late ? 'var(--bad)' : 'var(--ink-3)'} pointerEvents="none">
                      {(owner?.name ?? tk.ownerName ?? '').split(/[ ,]/)[0]}
                    </text>
                  </g>
                );
              })}

              {drag?.mode === 'link' && drag.pointer && (() => {
                const i = rowIndex.get(drag.id);
                const tk = plan.tasks.find((x) => x.id === drag.id);
                if (i === undefined || !tk) return null;
                const sx = tk.kind === 'milestone' ? x(tk.startDate) + dayW / 2 + 8 : x(addDays(tk.endDate, 1)) + 9;
                return <line x1={sx} y1={i * ROW + ROW / 2} x2={drag.pointer.x} y2={drag.pointer.y} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />;
              })()}

              {toDay(today) >= d0 && toDay(today) <= d1 && (
                <line x1={x(today) + dayW / 2} x2={x(today) + dayW / 2} y1={0} y2={height} stroke="var(--accent)" strokeWidth={1.5} pointerEvents="none" />
              )}
            </svg>
          </div>
        </div>
      </div>
      {canEdit && <div className="gantt-hint">{t('dragHint')}</div>}
      {tip.node}
    </div>
  );
}
