import { useState } from 'react';
import { Printer } from '@phosphor-icons/react';
import type { Health, ProjectSummary, StatusUpdate } from '../../shared/types';
import { addDays, diffDays, weekStart } from '../../shared/dates';
import { expectedProgress } from '../../shared/schedule';
import { progressKpi } from '../../shared/kpi';
import { api } from '../api';
import { useApp, useLoad } from '../lib/app';
import { useT } from '../lib/i18n';
import { deptName, fmtDate, projectName } from '../lib/format';
import { deptColor, ErrorState, HealthBadge, PageSkeleton } from '../components/ui';
import { DateRange, inRange, overlaps } from '../components/DateRange';
import type { Range } from '../components/DateRange';
import { stagger } from '../lib/motion';
import { LearnMore } from '../components/Tour';

// The executive report: the portfolio over a chosen period (this quarter unless changed). The projects that run in
// it, the milestones due and delivered in it, where it stands today and what needs a decision. Printable.

const ORDER: Health[] = ['on_track', 'done', 'at_risk', 'off_track', 'not_started'];
const COLOR: Record<Health, string> = {
  on_track: 'var(--ok)',
  done: 'var(--ink-2)',
  at_risk: 'var(--warn)',
  off_track: 'var(--bad)',
  not_started: 'var(--line-strong)',
};
const LIST = 12;

function thisQuarter(today: string): Range {
  const m = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
  const from = `${today.slice(0, 4)}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(`${from}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 3);
  return { from, to: addDays(end.toISOString().slice(0, 10), -1) };
}

/** Weekly buckets for a short period, monthly ones for a long one. */
function buckets(from: string, to: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  if (diffDays(from, to) <= 7 * 16) {
    for (let s = weekStart(from); s <= to; s = addDays(s, 7)) out.push({ start: s, end: addDays(s, 6) });
    return out;
  }
  let s = `${from.slice(0, 7)}-01`;
  while (s <= to) {
    const n = new Date(`${s}T00:00:00Z`);
    n.setUTCMonth(n.getUTCMonth() + 1);
    const next = n.toISOString().slice(0, 10);
    out.push({ start: s, end: addDays(next, -1) });
    s = next;
  }
  return out;
}

export function Report() {
  const { meta, dept } = useApp();
  const { t, lang } = useT();
  const today = meta.today;
  const week = weekStart(today);
  const [range, setRange] = useState<Range>(() => thisQuarter(today));
  const { data, error, reload } = useLoad(async () => {
    const [projects, cur, prev] = await Promise.all([
      api.get<ProjectSummary[]>('/api/projects?quarter='),
      api.get<{ updates: StatusUpdate[] }>(`/api/updates?week=${week}`),
      api.get<{ updates: StatusUpdate[] }>(`/api/updates?week=${addDays(week, -7)}`),
    ]);
    // Latest word from each project: this week's update, else last week's.
    const latest = new Map<number, StatusUpdate>();
    for (const u of prev.updates) latest.set(u.projectId, u);
    for (const u of cur.updates) latest.set(u.projectId, u);
    return { all: projects, latest };
  }, [week]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;

  const { all, latest } = data;
  // The projects of the period: those whose window touches it, and any still open that started before its end.
  const projects = all.filter((p) => overlaps(p.startDate, p.endDate, range) || (p.health !== 'done' && (!range.to || p.startDate <= range.to)));
  const active = projects.filter((p) => p.health !== 'done');
  const closed = projects.filter((p) => p.health === 'done' && inRange(p.endDate, range));
  // Health counts are over the active projects, the same base as the headline (closed ones are counted apart).
  const count = (h: Health, list = active) => list.filter((p) => p.health === h).length;
  const { actual: avg, expected } = progressKpi(active, today);
  const slipped = active.filter((p) => (p.baselineSlip ?? 0) > 0);
  const onTrackPct = active.length ? Math.round((count('on_track', active) / active.length) * 100) : 0;

  const milestones = projects.flatMap((p) => p.milestones.map((m) => ({ m, p }))).filter(({ m }) => inRange(m.date, range));
  const delivered = milestones.filter(({ m }) => m.done && m.date <= today).sort((a, b) => b.m.date.localeCompare(a.m.date));
  const open = milestones.filter(({ m }) => !m.done).sort((a, b) => a.m.date.localeCompare(b.m.date));
  const overdue = open.filter(({ m }) => m.date < today);
  const dueSoFar = milestones.filter(({ m }) => m.date <= today);
  const deliveryPct = dueSoFar.length ? Math.round((dueSoFar.filter(({ m }) => m.done).length / dueSoFar.length) * 100) : null;

  const attention = active
    .filter((p) => p.health === 'off_track' || p.health === 'at_risk')
    .sort((a, b) => (a.health === b.health ? a.code.localeCompare(b.code) : a.health === 'off_track' ? -1 : 1));
  const depts = meta.departments
    .map((d) => {
      const items = projects.filter((p) => p.departmentId === d.id);
      const ms = milestones.filter(({ p }) => p.departmentId === d.id);
      const live = items.filter((p) => p.health !== 'done');
      return {
        d,
        items,
        avg: live.length ? Math.round(live.reduce((s, p) => s + p.progress, 0) / live.length) : 100,
        done: ms.filter(({ m }) => m.done).length,
        due: ms.length,
      };
    })
    .filter((x) => x.items.length)
    .sort((a, b) => b.items.length - a.items.length);

  // The delivery trend over the period (all dates: from the first milestone to today's month).
  const allDates = milestones.map(({ m }) => m.date).sort();
  const tFrom = range.from || allDates[0] || today;
  const tTo = range.to || (allDates[allDates.length - 1] > today ? allDates[allDates.length - 1] : today);
  const trend = buckets(tFrom, tTo).map((b) => {
    const inB = milestones.filter(({ m }) => m.date >= b.start && m.date <= b.end);
    return { ...b, due: inB.length, done: inB.filter(({ m }) => m.done).length, future: b.start > today };
  });
  const peak = Math.max(1, ...trend.map((b) => b.due));
  const monthly = trend.length > 1 && diffDays(trend[0].start, trend[1].start) > 7;

  const periodLabel = range.from || range.to ? `${fmtDate(range.from || allDates[0] || today, lang, true)} – ${fmtDate(range.to || today, lang, true)}` : t('rep_periodAll');

  return (
    <>
      <div className="page-head no-print">
        <div>
          <h1 className="page-title">{t('report')}</h1>
          <LearnMore page="report" />
        </div>
        <div className="toolbar">
          <DateRange value={range} onChange={setRange} today={today} />
          <button className="btn btn-primary" onClick={() => window.print()}>
            <Printer size={16} aria-hidden />
            {t('printReport')}
          </button>
        </div>
      </div>

      <article className="report exec enter" style={stagger(1)}>
        <header className="exec-head">
          <div className="code">
            {t('rep_period')} · {t('asOf', { d: fmtDate(today, lang, true) })}
          </div>
          <h1>{periodLabel}</h1>
          <p className="lede">
            {t('summarySentence', {
              onTrack: count('on_track', active),
              total: active.length,
              atRisk: count('at_risk', active),
              offTrack: count('off_track', active),
              notStarted: count('not_started', active),
            })}
          </p>
        </header>

        {projects.length === 0 ? (
          <p className="muted" style={{ marginTop: 24 }}>
            {t('rep_noProjects')}
          </p>
        ) : (
          <>
            <div className="exec-kpis">
              <Kpi label={t('rep_kpiActive')} value={String(active.length)} note={t('rep_kpiActiveNote', { n: projects.length, closed: closed.length })} />
              <Kpi
                label={t('rep_kpiOnTrack')}
                value={`${onTrackPct}%`}
                note={t('rep_kpiOnTrackNote', { n: count('on_track', active), total: active.length })}
                tone={onTrackPct >= 70 ? 'ok' : onTrackPct >= 40 ? 'warn' : 'bad'}
              />
              <Kpi label={t('rep_kpiProgress')} value={`${avg}%`} note={`${t('rep_kpiProgressNote', { e: expected })} · ${t('def_progressShort', { n: active.length })}`} tone={avg + 5 >= expected ? 'ok' : avg + 15 >= expected ? 'warn' : 'bad'} bar={{ value: avg, mark: expected }} />
              <Kpi
                label={t('rep_kpiDelivered')}
                value={deliveryPct === null ? '–' : `${deliveryPct}%`}
                note={t('rep_kpiDeliveredNote', { d: dueSoFar.filter(({ m }) => m.done).length, n: dueSoFar.length })}
                tone={deliveryPct === null || deliveryPct >= 80 ? 'ok' : deliveryPct >= 60 ? 'warn' : 'bad'}
              />
              <Kpi label={t('rep_kpiOverdue')} value={String(overdue.length)} note={t('def_overdue')} tone={overdue.length ? 'bad' : 'ok'} />
              <Kpi label={t('rep_kpiSlipped')} value={String(slipped.length)} note={t('rep_kpiSlippedNote')} tone={slipped.length ? 'warn' : 'ok'} />
            </div>

            <div className="exec-grid">
              <section className="exec-card">
                <h2>{t('rep_healthMix')}</h2>
                <div className="health-strip exec-strip" role="img" aria-label={ORDER.map((h) => `${t(`health_${h}`)} ${count(h)}`).join(', ')}>
                  {ORDER.map((h) => (count(h) ? <span key={h} title={`${t(`health_${h}`)}: ${count(h)}`} style={{ flex: count(h), background: COLOR[h] }} /> : null))}
                </div>
                <ul className="exec-legend">
                  {ORDER.filter((h) => count(h) > 0).map((h) => (
                    <li key={h}>
                      <span className="swatch" style={{ background: COLOR[h] }} />
                      {t(`health_${h}`)}
                      <strong className="num">{count(h)}</strong>
                      <span className="muted num">{active.length ? Math.round((count(h) / active.length) * 100) : 0}%</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="exec-card">
                <h2>
                  {t('rep_trend')}
                  <span className="exec-key">
                    <i className="due" /> {t('rep_trendDue')} <i className="done" /> {t('rep_trendDone')}
                  </span>
                </h2>
                <div className="exec-trend" role="img" aria-label={trend.map((b) => `${fmtDate(b.start, lang)}: ${b.done}/${b.due}`).join(', ')}>
                  {trend.map((b, i) => (
                    <div key={b.start} className={`exec-col${b.future ? ' future' : ''}`} title={`${fmtDate(b.start, lang)} – ${fmtDate(b.end, lang)}: ${b.done} / ${b.due}`}>
                      <div className="exec-bars">
                        <span className="due" style={{ height: `${(b.due / peak) * 100}%` }} />
                        <span className="done" style={{ height: `${(b.done / peak) * 100}%` }} />
                      </div>
                      <span className="exec-tick">{i % Math.ceil(trend.length / 8) !== 0 ? ' ' : monthly ? new Date(`${b.start}T00:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar' : 'en-GB', { month: 'short', timeZone: 'UTC' }) : fmtDate(b.start, lang)}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <h2>{t('byDepartment')}</h2>
            <div className="table-wrap">
              <table className="table exec-depts">
                <thead>
                  <tr>
                    <th>{t('department')}</th>
                    <th className="num">{t('rep_colProjects')}</th>
                    <th style={{ width: '32%' }}>{t('rep_colHealth')}</th>
                    <th style={{ width: '18%' }}>{t('rep_colProgress')}</th>
                    <th className="num">{t('rep_colMilestones')}</th>
                  </tr>
                </thead>
                <tbody>
                  {depts.map(({ d, items, avg: dAvg, done, due }) => (
                    <tr key={d.id}>
                      <td>
                        <span className="swatch" style={{ background: deptColor(d.colorSlot), display: 'inline-block', marginInlineEnd: 8 }} />
                        {deptName(d, lang)}
                      </td>
                      <td className="num">{items.length}</td>
                      <td>
                        <div className="health-strip" style={{ height: 10 }}>
                          {ORDER.map((h) => {
                            const n = items.filter((p) => p.health === h).length;
                            return n ? <span key={h} title={`${t(`health_${h}`)}: ${n}`} style={{ flex: n, background: COLOR[h] }} /> : null;
                          })}
                        </div>
                      </td>
                      <td>
                        <div className="exec-progress">
                          <span style={{ width: `${dAvg}%` }} />
                        </div>
                        <span className="num ink-2" style={{ fontSize: 12 }}>
                          {dAvg}%
                        </span>
                      </td>
                      <td className="num">
                        {due ? (
                          <>
                            {done} / {due}
                          </>
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2>{t('needsAttention')}</h2>
            <p className="muted" style={{ margin: '-6px 0 12px', fontSize: 13 }}>
              {t('rep_attentionSub')}
            </p>
            {attention.length === 0 ? (
              <p className="muted">{t('nothingNeedsAttention')}</p>
            ) : (
              <div className="attention">
                {attention.map((p) => {
                  const u = latest.get(p.id);
                  const exp = expectedProgress(p.startDate, p.endDate, today);
                  const slip = p.baselineSlip ?? 0;
                  return (
                    <div key={p.id}>
                      <div>
                        <div className="code">
                          {p.code} {deptName(dept(p.departmentId), lang)}
                        </div>
                        <a href={`#/projects/${p.id}/plan`} style={{ fontWeight: 600, fontSize: 15, textDecoration: 'none' }}>
                          {projectName(p, lang)}
                        </a>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: 13 }}>
                          <HealthBadge health={p.health} />
                          <span className="ink-2">{p.managerName}</span>
                          <span className="num ink-2">
                            {p.progress}% / {exp}%
                          </span>
                          {slip > 0 && <span style={{ color: 'var(--bad)' }}>{t('slipDays', { n: slip })}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'grid', gap: 8 }}>
                        {(u?.blockers || p.blocker) && (
                          <div className="update-block">
                            <h4>{t('blockers')}</h4>
                            <p>{u?.blockers || p.blocker}</p>
                          </div>
                        )}
                        {u?.decisions && (
                          <div className="update-block is-decision">
                            <h4>{t('decisions')}</h4>
                            <p>{u.decisions}</p>
                          </div>
                        )}
                        {/* No weekly update yet: show the latest word from the tracker instead. */}
                        {!u && p.lastComment && (
                          <div className="update-block">
                            <h4>{t('latestUpdate')}</h4>
                            <p>{p.lastComment.length > 320 ? `${p.lastComment.slice(0, 319)}…` : p.lastComment}</p>
                          </div>
                        )}
                        {!u?.blockers && !p.blocker && !u?.decisions && !(!u && p.lastComment) && <span className="muted">{u ? u.accomplishments : t('noUpdateYet')}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="two-col">
              <MilestoneList title={t('rep_deliveredIn')} items={delivered} today={today} empty={t('noneInWindow')} />
              <MilestoneList title={t('rep_openIn')} items={open} today={today} empty={t('noneInWindow')} />
            </div>

            {closed.length > 0 && (
              <>
                <h2>{t('rep_closedIn')}</h2>
                <ul className="mlist">
                  {closed.map((p) => (
                    <li key={p.id}>
                      <span className="num muted">{fmtDate(p.endDate, lang)}</span>
                      <span>
                        {projectName(p, lang)} <span className="code">{p.code}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h2>{t('allProjects')}</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('project')}</th>
                    <th>{t('manager')}</th>
                    <th>{t('health')}</th>
                    <th className="num">{t('progress')}</th>
                    <th>{t('finish')}</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => {
                    const slip = p.baselineSlip ?? 0;
                    return (
                      <tr key={p.id}>
                        <td>
                          <a href={`#/projects/${p.id}/plan`} style={{ textDecoration: 'none' }}>
                            <span className="code">{p.code}</span> {projectName(p, lang)}
                          </a>
                        </td>
                        <td className="ink-2">{p.managerName}</td>
                        <td>
                          <HealthBadge health={p.health} />
                        </td>
                        <td className="num">{p.progress}%</td>
                        <td className="num">
                          {fmtDate(p.endDate, lang)}
                          {slip > 0 && <span style={{ color: 'var(--bad)', marginInlineStart: 6, fontSize: 12 }}>+{slip}d</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </article>
    </>
  );
}

function Kpi({ label, value, note, tone, bar }: { label: string; value: string; note: string; tone?: 'ok' | 'warn' | 'bad'; bar?: { value: number; mark: number } }) {
  return (
    <div className={`exec-kpi${tone ? ` tone-${tone}` : ''}`}>
      <span className="exec-kpi-label">{label}</span>
      <span className="exec-kpi-value num">{value}</span>
      {bar && (
        <span className="exec-progress" aria-hidden>
          <span style={{ width: `${bar.value}%` }} />
          <i style={{ insetInlineStart: `${bar.mark}%` }} />
        </span>
      )}
      <span className="exec-kpi-note">{note}</span>
    </div>
  );
}

function MilestoneList({
  title,
  items,
  today,
  empty,
}: {
  title: string;
  items: { m: ProjectSummary['milestones'][number]; p: ProjectSummary }[];
  today: string;
  empty: string;
}) {
  const { t, lang } = useT();
  return (
    <section>
      <h2>
        {title} <span className="muted num">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="mlist">
          {items.slice(0, LIST).map(({ m, p }) => (
            <li key={m.id}>
              <span className="num muted" style={{ color: !m.done && m.date < today ? 'var(--bad)' : undefined }}>
                {fmtDate(m.date, lang)}
              </span>
              <span>
                {m.name} <span className="code">{p.code}</span>
              </span>
            </li>
          ))}
          {items.length > LIST && <li className="muted">{t('rep_more', { n: items.length - LIST })}</li>}
        </ul>
      )}
    </section>
  );
}
