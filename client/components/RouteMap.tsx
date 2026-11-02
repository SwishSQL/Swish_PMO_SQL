import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { Department, ProjectSummary, Quarter, User } from '../../shared/types';
import { addDays, toDay, weekday } from '../../shared/dates';
import { expectedProgress } from '../../shared/schedule';
import { useT } from '../lib/i18n';
import { deptName, fmtDate, fmtMonth, projectName } from '../lib/format';
import { deptColor, HealthIcon, useTooltip } from './ui';

// The portfolio drawn as a transit map: each project is a line across the
// quarter, its milestones are stations, and the solid part of the line is
// the work already done. Where the solid part stops short of the Today line,
// the project is behind - visible without reading a number.

const LABEL_W = 300;
const AXIS_H = 56;
const GROUP_H = 36;
const ROW_H = 42;
const PAD_END = 56;

interface Props {
  projects: ProjectSummary[];
  departments: Department[];
  users: Map<number, User>;
  quarter: Quarter;
  today: string;
  onOpen: (id: number) => void;
}

export function RouteMap({ projects, departments, users, quarter, today, onOpen }: Props) {
  const { t, lang } = useT();
  const rtl = lang === 'ar';
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);
  const tip = useTooltip();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(940, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    const groups = departments
      .map((d) => ({ dept: d, items: projects.filter((p) => p.departmentId === d.id) }))
      .filter((g) => g.items.length > 0);
    let y = AXIS_H;
    const rows: ({ kind: 'group'; dept: Department; count: number; y: number } | { kind: 'project'; p: ProjectSummary; dept: Department; y: number; n: number })[] = [];
    let n = 0;
    for (const g of groups) {
      rows.push({ kind: 'group', dept: g.dept, count: g.items.length, y });
      y += GROUP_H;
      for (const p of [...g.items].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.code.localeCompare(b.code))) {
        rows.push({ kind: 'project', p, dept: g.dept, y, n: n++ });
        y += ROW_H;
      }
    }
    return { rows, height: y + 16 };
  }, [projects, departments]);

  // Time domain: the quarter with a margin each side. Work that began earlier
  // or runs later leaves the frame at the edge (it is clipped, not squeezed in),
  // so one long project cannot flatten everything else.
  const latest = projects.reduce((m, p) => (p.endDate > m ? p.endDate : m), quarter.endsOn);
  const earliest = projects.reduce((m, p) => (p.startDate < m ? p.startDate : m), quarter.startsOn);
  const lo = addDays(quarter.startsOn, -14);
  const hi = addDays(quarter.endsOn, 45);
  const d0 = toDay(earliest > lo ? addDays(earliest, -3) : lo);
  const d1 = toDay(addDays(latest < hi ? latest : hi, 6));
  const plotW = width - LABEL_W - PAD_END;
  const xRaw = (iso: string) => LABEL_W + ((toDay(iso) - d0) / (d1 - d0)) * plotW;
  const x = (iso: string) => (rtl ? width - xRaw(iso) : xRaw(iso));
  const plotLeft = rtl ? 0 : LABEL_W;
  const anchor = rtl ? 'end' : 'start';

  // Stations closer than a finger-width merge into one numbered station.
  const stationsOf = (p: ProjectSummary) => {
    const sorted = [...p.milestones].sort((a, b) => a.date.localeCompare(b.date));
    const out: { items: typeof sorted; x: number }[] = [];
    for (const m of sorted) {
      const mx = x(m.date);
      const last = out[out.length - 1];
      if (last && Math.abs(mx - last.x) < 13) last.items.push(m);
      else out.push({ items: [m], x: mx });
    }
    return out;
  };

  // Month bands and week ticks.
  const months: { start: string; end: string }[] = [];
  {
    let m = `${addDays(quarter.startsOn, 0).slice(0, 8)}01`;
    while (toDay(m) <= d1) {
      const [yy, mm] = m.split('-').map(Number);
      const next = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
      months.push({ start: m, end: addDays(next, -1) });
      m = next;
    }
  }
  const weeks: string[] = [];
  for (let d = d0; d <= d1; d++) {
    const iso = new Date(d * 86_400_000).toISOString().slice(0, 10);
    if (weekday(iso) === 0) weeks.push(iso);
  }
  const clampIso = (iso: string) => (toDay(iso) < d0 ? addDays(iso, d0 - toDay(iso)) : toDay(iso) > d1 ? addDays(iso, d1 - toDay(iso)) : iso);
  const qEndX = x(addDays(quarter.endsOn, 1));
  const todayX = x(today);
  const showToday = toDay(today) >= d0 && toDay(today) <= d1;

  const keyOpen = (e: KeyboardEvent, id: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(id);
    }
  };

  return (
    <div className="routemap" ref={wrap}>
      <svg width={width} height={layout.height} role="list" aria-label={t('routeMap')} direction="ltr">
        <defs>
          <clipPath id="rm-plot">
            <rect x={plotLeft} y={AXIS_H} width={width - LABEL_W} height={layout.height} />
          </clipPath>
          <clipPath id="rm-label-clip">
            <rect x={rtl ? width - LABEL_W + 8 : 0} y={0} width={LABEL_W - 8} height={layout.height} />
          </clipPath>
          <pattern id="rm-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--line)" strokeWidth="2" />
          </pattern>
        </defs>

        {/* Past the quarter's end: hatched, so overruns read as overruns. */}
        {toDay(latest) > toDay(quarter.endsOn) && (
          <g>
            <rect
              x={Math.min(qEndX, x(clampIso(addDays(latest, 6))))}
              y={AXIS_H - 8}
              width={Math.abs(x(clampIso(addDays(latest, 6))) - qEndX)}
              height={layout.height - AXIS_H}
              fill="url(#rm-hatch)"
              opacity={0.7}
            />
            <text className="rm-axis" x={rtl ? qEndX - 8 : qEndX + 8} y={AXIS_H - 14} textAnchor={anchor}>
              {t('outsideQuarter')}
            </text>
          </g>
        )}

        {/* Axis */}
        {months.map((m, i) => {
          const a = x(clampIso(m.start));
          const b = x(clampIso(addDays(m.end, 1)));
          return (
            <g key={m.start}>
              {i > 0 && <line x1={a} x2={a} y1={14} y2={layout.height} stroke="var(--line-strong)" strokeWidth={1} />}
              <text className="rm-month" x={(a + b) / 2} y={24} textAnchor="middle">
                {fmtMonth(m.start, lang)}
              </text>
            </g>
          );
        })}
        {weeks.map((w) => (
          <g key={w}>
            <line x1={x(w)} x2={x(w)} y1={AXIS_H - 6} y2={layout.height} stroke="var(--line)" strokeWidth={1} />
            {/* Day labels give way to the Today pill and to the overrun note. */}
            {Math.abs(x(w) - todayX) > 40 && w <= quarter.endsOn && (
              <text className="rm-axis num" x={x(w)} y={AXIS_H - 12} textAnchor="middle">
                {Number(w.slice(8))}
              </text>
            )}
          </g>
        ))}
        <line x1={0} x2={width} y1={AXIS_H - 0.5} y2={AXIS_H - 0.5} stroke="var(--line-strong)" />

        {layout.rows.map((row) => {
          if (row.kind === 'group') {
            return (
              <g key={`g${row.dept.id}`}>
                <rect x={0} y={row.y} width={width} height={GROUP_H} fill="var(--surface-2)" />
                <rect x={rtl ? width - 20 - 10 : 20} y={row.y + GROUP_H / 2 - 5} width={10} height={10} rx={3} fill={deptColor(row.dept.colorSlot)} />
                <text className="rm-dept" x={rtl ? width - 38 : 38} y={row.y + GROUP_H / 2 + 4} textAnchor={anchor}>
                  {deptName(row.dept, lang)}
                  <tspan className="rm-code" dx={8}>
                    {row.count}
                  </tspan>
                </text>
              </g>
            );
          }
          const { p, dept } = row;
          const color = deptColor(dept.colorSlot);
          const cy = row.y + ROW_H / 2;
          const xs = x(p.startDate);
          const xe = x(addDays(p.endDate, 1));
          const doneX = xs + (xe - xs) * (p.progress / 100);
          const expected = expectedProgress(p.startDate, p.endDate, today);
          // Still open after its planned finish: a red tail runs on to Today.
          // Same rule as the server's quarter list. The tail stops at the chart
          // edge when Today is outside the frame, so the label stays visible.
          const lateDays =
            p.stage !== 'closed' && p.health !== 'done' && p.progress < 100 && p.endDate < today ? toDay(today) - toDay(p.endDate) : 0;
          const tailX = lateDays > 0 ? x(clampIso(today)) : xe;
          const pm = users.get(p.managerId ?? -1);
          const name = projectName(p, lang);
          const short = name.length > 38 ? `${name.slice(0, 37)}…` : name;
          const showTip = (e: MouseEvent) =>
            tip.show(
              e,
              <>
                <strong>{name}</strong>
                <div>
                  {t(`health_${p.health}`)}. {t('progress')} {p.progress}%
                </div>
                <div className="tt-dim">
                  {expected - p.progress > 3
                    ? t('behindBy', { n: expected - p.progress })
                    : p.progress - expected > 3
                      ? t('aheadBy', { n: p.progress - expected })
                      : `${fmtDate(p.startDate, lang)} - ${fmtDate(p.endDate, lang)}`}
                </div>
                {lateDays > 0 && <div className="tt-bad">{t('pastFinish', { n: lateDays, d: fmtDate(p.endDate, lang) })}</div>}
                {(pm?.name ?? p.managerName) && <div className="tt-dim">{pm?.name ?? p.managerName}</div>}
              </>,
            );
          return (
            <g
              key={p.id}
              className="rm-row"
              role="listitem"
              tabIndex={0}
              aria-label={`${p.code} ${name}. ${t(`health_${p.health}`)}. ${t('progress')} ${p.progress}%.`}
              onClick={() => onOpen(p.id)}
              onKeyDown={(e) => keyOpen(e, p.id)}
            >
              <rect className="rm-hover" x={0} y={row.y} width={width} height={ROW_H} fill="transparent" />
              <g clipPath="url(#rm-label-clip)">
                <g className={`h-${p.health}`}>
                  <HealthIcon health={p.health} size={16} x={rtl ? width - 20 - 16 : 20} y={cy - 8} />
                </g>
                <text className="rm-label" x={rtl ? width - 44 : 44} y={cy + 4.5} textAnchor={anchor}>
                  {short}
                </text>
              </g>

              <g clipPath="url(#rm-plot)">
              {/* Planned window, then the done part on top. Both draw in on arrival. */}
              <line
                className="rm-line rm-draw"
                pathLength={1}
                style={{ ['--i' as string]: row.n }}
                x1={xs}
                x2={xe}
                y1={cy}
                y2={cy}
                stroke={color}
                strokeOpacity={0.3}
                strokeWidth={6}
                strokeLinecap="round"
                onMouseMove={showTip}
                onMouseLeave={tip.hide}
              />
              {p.progress > 0 && (
                <line
                  className="rm-line rm-draw-done"
                  pathLength={1}
                  style={{ ['--i' as string]: row.n }}
                  x1={xs}
                  x2={doneX}
                  y1={cy}
                  y2={cy}
                  stroke={color}
                  strokeWidth={6}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
              )}
              {lateDays > 0 && (
                <line
                  className="rm-stop"
                  style={{ ['--i' as string]: row.n, ['--j' as string]: 6 }}
                  x1={xe}
                  x2={tailX}
                  y1={cy}
                  y2={cy}
                  stroke="var(--bad)"
                  strokeWidth={2.5}
                  strokeDasharray="2 5"
                  strokeLinecap="round"
                  pointerEvents="none"
                />
              )}
              {/* A wide invisible strip over the tail: when the planned line
                  has scrolled out of frame, the tail still answers the hover. */}
              {lateDays > 0 && (
                <line x1={xe} x2={tailX} y1={cy} y2={cy} stroke="transparent" strokeWidth={14} onMouseMove={showTip} onMouseLeave={tip.hide} />
              )}
              {/* Terminus */}
              <line
                className="rm-stop"
                style={{ ['--i' as string]: row.n, ['--j' as string]: 6 }}
                x1={xe}
                x2={xe}
                y1={cy - 8}
                y2={cy + 8}
                stroke={color}
                strokeWidth={3}
                strokeLinecap="round"
                pointerEvents="none"
              />
              <text
                className="rm-code num rm-stop"
                style={{ ['--i' as string]: row.n, ['--j' as string]: 7, ...(lateDays > 0 ? { fill: 'var(--bad)', fontWeight: 600 } : {}) }}
                x={rtl ? tailX - 10 : tailX + 10}
                y={cy + 4}
                textAnchor={anchor}
                pointerEvents="none"
              >
                {p.progress}%{lateDays > 0 ? ` · ${t('lateDaysShort', { n: lateDays })}` : ''}
              </text>

              {stationsOf(p)
                .filter((st) => st.x > plotLeft + 10 && st.x < plotLeft + (width - LABEL_W) - 6)
                .map((st, j) => {
                const first = st.items[0];
                const many = st.items.length > 1;
                const allDone = st.items.every((m) => m.done);
                const late = st.items.some((m) => !m.done && m.date < today);
                const slipped = !many && first.baselineDate && first.baselineDate !== first.date;
                const ring = late ? 'var(--bad)' : allDone ? 'var(--surface)' : color;
                return (
                  <g
                    key={first.id}
                    className="rm-stop"
                    style={{ ['--i' as string]: row.n, ['--j' as string]: Math.min(j, 12) }}
                    onMouseMove={(e) =>
                      tip.show(
                        e,
                        many ? (
                          <>
                            <strong>{t('groupedMilestones', { n: st.items.length })}</strong>
                            <div>
                              {fmtDate(first.date, lang)}
                              {st.items[st.items.length - 1].date !== first.date ? ` - ${fmtDate(st.items[st.items.length - 1].date, lang)}` : ''}
                            </div>
                            {st.items.slice(0, 4).map((m) => (
                              <div key={m.id} className="tt-dim">
                                {m.done ? '✓ ' : ''}
                                {m.name.length > 56 ? `${m.name.slice(0, 55)}…` : m.name}
                              </div>
                            ))}
                            {st.items.length > 4 && <div className="tt-dim">+{st.items.length - 4}</div>}
                          </>
                        ) : (
                          <>
                            <strong>{first.name.length > 90 ? `${first.name.slice(0, 89)}…` : first.name}</strong>
                            <div>
                              {fmtDate(first.date, lang, true)}.{' '}
                              {first.done ? t('milestoneDone') : late ? t('milestoneLate') : t('milestoneUpcoming')}
                            </div>
                            {slipped && <div className="tt-dim">{t('movedFrom', { d: fmtDate(first.baselineDate!, lang) })}</div>}
                          </>
                        ),
                      )
                    }
                    onMouseLeave={tip.hide}
                  >
                    {slipped && (
                      <>
                        <line x1={x(first.baselineDate!)} x2={st.x} y1={cy - 11} y2={cy - 11} stroke="var(--ink-3)" strokeWidth={1.5} strokeDasharray="2 3" />
                        <circle cx={x(first.baselineDate!)} cy={cy - 11} r={2.5} fill="var(--ink-3)" />
                      </>
                    )}
                    <circle cx={st.x} cy={cy} r={11} fill="transparent" />
                    <circle
                      cx={st.x}
                      cy={cy}
                      r={many ? 8 : 6}
                      fill={allDone ? color : 'var(--surface)'}
                      stroke={ring}
                      strokeWidth={allDone ? 2.5 : 3}
                    />
                    {many && (
                      <text x={st.x} y={cy + 3.2} textAnchor="middle" fontSize={9} fontWeight={700} fill={allDone ? '#fff' : 'var(--ink)'} pointerEvents="none">
                        {st.items.length}
                      </text>
                    )}
                  </g>
                );
              })}
              </g>
            </g>
          );
        })}

        {showToday && (
          <g pointerEvents="none">
            <line className="rm-today-line" pathLength={1} x1={todayX} x2={todayX} y1={AXIS_H - 4} y2={layout.height - 6} stroke="var(--accent)" strokeWidth={2} />
            <g className="rm-today-pill">
              <circle className="live-dot" cx={todayX} cy={AXIS_H - 20} r={10} fill="var(--accent)" opacity={0.5} />
              <rect x={todayX - 34} y={AXIS_H - 30} width={68} height={20} rx={10} fill="var(--accent)" />
              <text x={todayX} y={AXIS_H - 16} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="var(--accent-ink)">
                {fmtDate(today, lang)}
              </text>
            </g>
          </g>
        )}
      </svg>
      {tip.node}
    </div>
  );
}

export function RouteLegend() {
  const { t } = useT();
  const c = 'var(--ink-2)';
  return (
    <div className="strip-legend" style={{ marginTop: 0 }} aria-hidden>
      <span>
        <svg width="34" height="10">
          <line x1="3" x2="31" y1="5" y2="5" stroke={c} strokeOpacity="0.3" strokeWidth="6" strokeLinecap="round" />
          <line x1="3" x2="16" y1="5" y2="5" stroke={c} strokeWidth="6" strokeLinecap="round" />
        </svg>
        {t('progress')}
      </span>
      <span>
        <svg width="14" height="14">
          <circle cx="7" cy="7" r="5" fill={c} stroke="var(--surface)" strokeWidth="2" />
        </svg>
        {t('milestoneDone')}
      </span>
      <span>
        <svg width="14" height="14">
          <circle cx="7" cy="7" r="4.5" fill="var(--surface)" stroke={c} strokeWidth="2.5" />
        </svg>
        {t('milestoneUpcoming')}
      </span>
      <span>
        <svg width="14" height="14">
          <circle cx="7" cy="7" r="4.5" fill="var(--surface)" stroke="var(--bad)" strokeWidth="2.5" />
        </svg>
        {t('milestoneLate')}
      </span>
      <span>
        <svg width="26" height="10">
          <circle cx="4" cy="5" r="2.5" fill="var(--ink-3)" />
          <line x1="4" x2="24" y1="5" y2="5" stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="2 3" />
        </svg>
        {t('baseline')}
      </span>
      <span>
        <svg width="4" height="14">
          <line x1="2" x2="2" y1="0" y2="14" stroke="var(--accent)" strokeWidth="2" />
        </svg>
        {t('today')}
      </span>
    </div>
  );
}
