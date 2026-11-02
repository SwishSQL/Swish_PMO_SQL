import { useMemo } from 'react';
import { ArrowRight, Hourglass, WarningOctagon, CalendarCheck, Siren, Flag, ChartDonut, Megaphone, SealQuestion } from '@phosphor-icons/react';
import type { MilestoneRow, ProjectSummary } from '../../shared/types';
import { addDays, weekStart } from '../../shared/dates';
import { milestoneFlags, STALE_DAYS, WARNING_DAYS } from '../../shared/health';
import { api } from '../api';
import { useApp, useLoad } from '../lib/app';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { fmtDate, projectName, relativeDays } from '../lib/format';
import { CountUp, stagger } from '../lib/motion';
import { ClosureQueue } from '../components/ClosureQueue';
import { ChangeQueue } from '../components/ChangeQueue';
import { ErrorState, ExportButton, HealthBadge, Meter, PageSkeleton, Person } from '../components/ui';

/**
 * The weekly review in numbers: how many milestones are late, stale, or heading
 * for a miss, which ones, and which projects carry them. Everything is worked
 * out from the milestones themselves (shared/health.ts), so it agrees with the
 * Milestones page and the Excel export.
 */
export function Dashboard() {
  const { meta, user, can } = useApp();
  const { t, lang } = useT();
  const today = meta.today;
  const ms = useLoad(() => api.get<MilestoneRow[]>('/api/milestones'), [], 'milestones');
  const pr = useLoad(() => api.get<ProjectSummary[]>('/api/projects'), [], 'projects-all');

  const view = useMemo(() => {
    if (!ms.data || !pr.data) return null;
    const rows = ms.data.map((m) => ({ m, f: milestoneFlags(m, today) }));
    const open = rows.filter((r) => r.f.open);
    const weekEnd = addDays(today, 7);
    const sum = {
      overdue: open.filter((r) => r.f.overdue).length,
      week: open.filter((r) => r.m.date >= today && r.m.date <= weekEnd).length,
      stale: open.filter((r) => r.f.needsUpdate).length,
      warning: open.filter((r) => r.f.earlyWarning || r.f.autoAtRisk).length,
      blocked: open.filter((r) => r.f.earlyWarning).length,
      escMissing: open.filter((r) => r.f.escalationMissing).length,
      escLate: open.filter((r) => r.f.escalationLate).length,
      approve: rows.filter((r) => r.m.pendingChanges > 0).length,
      soon: open.filter((r) => r.f.autoAtRisk).length,
    };
    // Worst first: how late, then blocked, then due-soon-not-started, then stale.
    const score = (r: (typeof rows)[number]) =>
      r.f.overdue ? 4000 + Math.min(999, Math.round((Date.parse(today) - Date.parse(r.m.date)) / 86_400_000)) : r.f.earlyWarning ? 3000 : r.f.autoAtRisk ? 2000 : 1000;
    const exceptions = open
      .filter((r) => r.f.overdue || r.f.earlyWarning || r.f.autoAtRisk || r.f.needsUpdate || r.f.escalationLate)
      .sort((a, b) => score(b) - score(a) || a.m.date.localeCompare(b.m.date));
    // Milestones due in each of the next four weeks (Sunday weeks, Kuwait).
    const w0 = weekStart(today);
    const weeks = [0, 1, 2, 3].map((i) => {
      const from = addDays(w0, i * 7);
      const to = addDays(from, 6);
      return { from, count: open.filter((r) => r.m.date >= from && r.m.date <= to && r.m.date >= today).length };
    });
    const perProject = new Map<number, { overdue: number; stale: number; warning: number; last: string | null }>();
    for (const r of open) {
      const p = perProject.get(r.m.projectId) ?? { overdue: 0, stale: 0, warning: 0, last: null };
      if (r.f.overdue) p.overdue++;
      if (r.f.needsUpdate) p.stale++;
      if (r.f.earlyWarning || r.f.autoAtRisk) p.warning++;
      perProject.set(r.m.projectId, p);
    }
    for (const r of rows) {
      const p = perProject.get(r.m.projectId);
      if (p && r.m.lastUpdateOn && (!p.last || r.m.lastUpdateOn > p.last)) p.last = r.m.lastUpdateOn;
    }
    const active = pr.data.filter((p) => p.health !== 'done');
    const health = {
      on_track: active.filter((p) => p.health === 'on_track').length,
      at_risk: active.filter((p) => p.health === 'at_risk').length,
      off_track: active.filter((p) => p.health === 'off_track').length,
      not_started: active.filter((p) => p.health === 'not_started').length,
    };
    const review = active
      .map((p) => ({ p, c: perProject.get(p.id) ?? { overdue: 0, stale: 0, warning: 0, last: null } }))
      .sort((a, b) => b.c.overdue - a.c.overdue || b.c.warning - a.c.warning || b.c.stale - a.c.stale || a.p.code.localeCompare(b.p.code));
    return { sum, exceptions, weeks, health, review, activeCount: active.length, total: pr.data.length };
  }, [ms.data, pr.data, today]);

  if (ms.error || pr.error) return <ErrorState message={(ms.error ?? pr.error)!} onRetry={() => (ms.reload(), pr.reload())} />;
  if (!view) return <PageSkeleton />;
  const { sum, weeks } = view;
  const maxWeek = Math.max(1, ...weeks.map((w) => w.count));
  const tiles = [
    { key: 'overdue', icon: WarningOctagon, n: sum.overdue, tone: 'bad', filter: 'overdue' },
    { key: 'week', icon: CalendarCheck, n: sum.week, tone: '', filter: 'week' },
    { key: 'stale', icon: Hourglass, n: sum.stale, tone: 'warn', filter: 'stale', sub: t('dash_staleSub', { n: STALE_DAYS }) },
    {
      key: 'lateEsc',
      icon: Megaphone,
      n: sum.escMissing + sum.escLate,
      tone: 'bad',
      filter: 'lateesc',
      sub: t('dash_lateEscSub', { m: sum.escMissing, l: sum.escLate }),
    },
    { key: 'approve', icon: SealQuestion, n: sum.approve, tone: 'warn', filter: 'approval', sub: t('dash_approveSub') },
    {
      key: 'warning',
      icon: Siren,
      n: sum.warning,
      tone: 'warn',
      filter: 'warning',
      sub: t('dash_warningSub', { b: sum.blocked, s: sum.soon, d: WARNING_DAYS }),
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('dashboard')}</h1>
          <p className="page-sub">{t('dashboardSub', { a: view.activeCount, n: view.total })}</p>
        </div>
        <div className="toolbar">
          <ExportButton url="/api/export/portfolio.xlsx?quarter=all">{t('exportExcel')}</ExportButton>
        </div>
      </div>

      {can('projects.approve_close') && <ClosureQueue />}
      <ChangeQueue />

      <div className="dash-tiles">
        {tiles.map((x, i) => (
          <a key={x.key} className={`dash-tile enter ${x.tone}`} style={stagger(i)} href={`#/milestones?status=${x.filter}`}>
            <x.icon size={22} weight="duotone" aria-hidden />
            <span className="figure num">
              <CountUp value={x.n} />
            </span>
            <span className="figure-label">{t(`dash_${x.key}` as TKey)}</span>
            {x.sub && <span className="dash-sub">{x.sub}</span>}
            <ArrowRight size={14} className="dash-go" aria-hidden />
          </a>
        ))}
      </div>

      <div className="dash-grid">
        <section className="panel enter" style={stagger(4)}>
          <div className="panel-body">
            <h2 className="panel-title">
              <ChartDonut size={16} aria-hidden /> {t('dash_projectsByHealth')}
            </h2>
            <div className="health-strip" style={{ height: 10, margin: '14px 0 10px' }} aria-hidden>
              {(['on_track', 'at_risk', 'off_track', 'not_started'] as const).map(
                (h) => view.health[h] > 0 && <span key={h} style={{ flex: view.health[h] }} className={`seg-${h}`} />,
              )}
            </div>
            <div className="dash-legend">
              {(['on_track', 'at_risk', 'off_track', 'not_started'] as const).map((h) => (
                <span key={h} className={`h-${h}`}>
                  <b className="num">{view.health[h]}</b> {t(`health_${h}`)}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="panel enter" style={stagger(5)}>
          <div className="panel-body">
            <h2 className="panel-title">
              <Flag size={16} aria-hidden /> {t('dash_next4')}
            </h2>
            <div className="week-bars" role="img" aria-label={t('dash_next4')}>
              {weeks.map((w, i) => (
                <div key={w.from} className="week-bar">
                  <span className="num">{w.count}</span>
                  <i style={{ height: `${Math.max(4, (w.count / maxWeek) * 70)}px`, animationDelay: `${i * 70}ms` }} />
                  <small>{fmtDate(w.from, lang)}</small>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="panel enter" style={stagger(6)}>
        <div className="panel-body" style={{ paddingBottom: 6 }}>
          <h2 className="panel-title">{t('dash_exceptions')}</h2>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            {t('dash_exceptionsSub', { n: view.exceptions.length })}
          </p>
        </div>
        {view.exceptions.length === 0 ? (
          <div className="panel-body muted">{t('dash_allClear')}</div>
        ) : (
          <div className="table-wrap">
            <table className="table ms-table">
              <thead>
                <tr>
                  <th>{t('dueDate')}</th>
                  <th>{t('kind_milestone')}</th>
                  <th>{t('project')}</th>
                  <th>{t('responsibleOwner')}</th>
                  <th>{t('blockerLabel')}</th>
                  <th>{t('latestUpdate')}</th>
                </tr>
              </thead>
              <tbody>
                {view.exceptions.slice(0, 25).map(({ m, f }) => (
                  <tr key={m.id} className="clickable" onClick={() => (window.location.hash = `#/projects/${m.projectId}/plan?task=${m.id}`)}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDate(m.date, lang)}
                      <div className={f.overdue ? 'bad' : 'muted'} style={{ fontSize: 12 }}>
                        {relativeDays(m.date, today, lang)}
                      </div>
                    </td>
                    <td style={{ minWidth: 260, maxWidth: 420 }}>
                      <div>{m.name}</div>
                      <div className="flag-chips">
                        {f.overdue && <span className="flag-chip bad">{t('milestoneLate')}</span>}
                        {f.earlyWarning && <span className="flag-chip warn">{t('flag_earlyWarning')}</span>}
                        {f.autoAtRisk && <span className="flag-chip warn">{t('flag_autoAtRisk')}</span>}
                        {f.needsUpdate && <span className="flag-chip">{t('flag_needsUpdate')}</span>}
                        {f.escalationMissing && <span className="flag-chip bad">{t('flag_escalationMissing')}</span>}
                        {f.escalationLate && <span className="flag-chip warn">{t('flag_escalationLate')}</span>}
                      </div>
                    </td>
                    <td>
                      <span className="code">{m.projectCode}</span>
                      <div style={{ fontSize: 13 }}>{lang === 'ar' && m.projectNameAr ? m.projectNameAr : m.projectName}</div>
                    </td>
                    <td style={{ fontSize: 13 }}>{m.ownerName ?? '-'}</td>
                    <td style={{ fontSize: 13, maxWidth: 280 }}>
                      <div className="clamp-2 ink-2">{m.blocker ?? '-'}</div>
                    </td>
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{m.lastUpdateOn ? fmtDate(m.lastUpdateOn, lang) : <span className="muted">{t('neverUpdated')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.exceptions.length > 25 && (
              <div className="panel-body" style={{ borderTop: '1px solid var(--line)', textAlign: 'center' }}>
                <a className="btn" href="#/milestones?status=overdue">
                  {t('dash_seeAll', { n: view.exceptions.length })}
                </a>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel enter" style={{ marginTop: 16, ...stagger(7) }}>
        <div className="panel-body" style={{ paddingBottom: 6 }}>
          <h2 className="panel-title">{t('dash_projectsReview')}</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('project')}</th>
                <th>{t('manager')}</th>
                <th>{t('progress')}</th>
                <th>{t('health')}</th>
                <th>{t('msFilter_overdue')}</th>
                <th>{t('flag_earlyWarning')}</th>
                <th>{t('flag_needsUpdate')}</th>
                <th>{t('latestUpdate')}</th>
              </tr>
            </thead>
            <tbody>
              {view.review.map(({ p, c }) => (
                <tr key={p.id} className="clickable" onClick={() => (window.location.hash = `#/projects/${p.id}/plan`)}>
                  <td style={{ minWidth: 240 }}>
                    <span className="code">{p.code}</span>
                    <div>{projectName(p, lang)}</div>
                  </td>
                  <td>
                    <Person user={user(p.managerId)} name={p.managerName} />
                  </td>
                  <td style={{ minWidth: 120 }}>
                    <Meter value={p.progress} />
                    <span className="num" style={{ fontSize: 12 }}>{p.progress}%</span>
                  </td>
                  <td>
                    <HealthBadge health={p.health} pill />
                  </td>
                  <td className={`num ${c.overdue ? 'bad' : 'muted'}`}>{c.overdue}</td>
                  <td className={`num ${c.warning ? 'warn' : 'muted'}`}>{c.warning}</td>
                  <td className={`num ${c.stale ? 'warn' : 'muted'}`}>{c.stale}</td>
                  <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{c.last ? fmtDate(c.last, lang) : <span className="muted">{t('neverUpdated')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
