import { Printer } from '@phosphor-icons/react';
import type { Health, ProjectSummary, StatusUpdate } from '../../shared/types';
import { addDays, diffDays, weekStart } from '../../shared/dates';
import { expectedProgress } from '../../shared/schedule';
import { api } from '../api';
import { useApp, useLoad } from '../lib/app';
import { useT } from '../lib/i18n';
import { deptName, fmtDate, projectName } from '../lib/format';
import { deptColor, ErrorState, HealthBadge, PageSkeleton } from '../components/ui';
import { stagger } from '../lib/motion';

const ORDER: Health[] = ['on_track', 'done', 'at_risk', 'off_track', 'not_started'];
const COLOR: Record<Health, string> = {
  on_track: 'var(--ok)',
  done: 'var(--ink-2)',
  at_risk: 'var(--warn)',
  off_track: 'var(--bad)',
  not_started: 'var(--line-strong)',
};

export function Report() {
  const { meta, quarterId, user, dept } = useApp();
  const { t, lang } = useT();
  const today = meta.today;
  const week = weekStart(today);
  const { data, error, reload } = useLoad(async () => {
    const [projects, cur, prev] = await Promise.all([
      api.get<ProjectSummary[]>(`/api/projects?quarter=${quarterId ?? ''}`),
      api.get<{ updates: StatusUpdate[] }>(`/api/updates?week=${week}`),
      api.get<{ updates: StatusUpdate[] }>(`/api/updates?week=${addDays(week, -7)}`),
    ]);
    // Latest word from each project: this week's update, else last week's.
    const latest = new Map<number, StatusUpdate>();
    for (const u of prev.updates) latest.set(u.projectId, u);
    for (const u of cur.updates) latest.set(u.projectId, u);
    return { projects, latest };
  }, [quarterId, week]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;

  const { projects, latest } = data;
  const quarter = meta.quarters.find((q) => q.id === quarterId);
  const count = (h: Health) => projects.filter((p) => p.health === h).length;
  const avg = projects.length ? Math.round(projects.reduce((s, p) => s + p.progress, 0) / projects.length) : 0;
  const timeGone = quarter ? expectedProgress(quarter.startsOn, quarter.endsOn, today) : 0;
  const attention = projects
    .filter((p) => p.health === 'off_track' || p.health === 'at_risk')
    .sort((a, b) => (a.health === b.health ? a.code.localeCompare(b.code) : a.health === 'off_track' ? -1 : 1));
  const milestones = projects.flatMap((p) => p.milestones.map((m) => ({ m, p })));
  const achieved = milestones
    .filter(({ m }) => m.done && m.date <= today && diffDays(m.date, today) <= 14)
    .sort((a, b) => b.m.date.localeCompare(a.m.date));
  const upcoming = milestones
    .filter(({ m }) => !m.done && m.date >= today && diffDays(today, m.date) <= 14)
    .sort((a, b) => a.m.date.localeCompare(b.m.date));
  const overdue = milestones.filter(({ m }) => !m.done && m.date < today);
  const depts = meta.departments
    .map((d) => ({ d, items: projects.filter((p) => p.departmentId === d.id) }))
    .filter((x) => x.items.length);

  return (
    <>
      <div className="page-head no-print">
        <div>
          <h1 className="page-title">{t('report')}</h1>
        </div>
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => window.print()}>
            <Printer size={16} aria-hidden />
            {t('printReport')}
          </button>
        </div>
      </div>

      <article className="report enter" style={stagger(1)}>
        <div className="code">{t('asOf', { d: fmtDate(today, lang, true) })}</div>
        <h1 style={{ marginTop: 6 }}>
          {quarter ? `Q${quarter.q} ${quarter.year}` : ''} {t('portfolio')}
        </h1>
        <p className="lede">
          {t('summarySentence', {
            onTrack: count('on_track'),
            total: projects.length - count('done'),
            atRisk: count('at_risk'),
            offTrack: count('off_track'),
            notStarted: count('not_started'),
          })}
        </p>
        <p className="lede">{t('summaryProgress', { done: avg, time: timeGone })}</p>
        {overdue.length > 0 && (
          <p className="lede" style={{ color: 'var(--bad)' }}>
            {overdue.length} {t('milestoneLate').toLowerCase()}: {overdue.slice(0, 3).map(({ m, p }) => `${m.name} (${p.code})`).join(', ')}
            {overdue.length > 3 ? '...' : ''}
          </p>
        )}

        <h2>{t('byDepartment')}</h2>
        <div className="strip-legend" style={{ margin: '0 0 14px' }}>
          {ORDER.filter((h) => count(h) > 0).map((h) => (
            <HealthBadge key={h} health={h} />
          ))}
        </div>
        <div className="dept-bars">
          {depts.map(({ d, items }, di) => {
            const dAvg = Math.round(items.reduce((s, p) => s + p.progress, 0) / items.length);
            return (
              <div key={d.id} className="dept-bar enter" style={stagger(di)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span className="swatch" style={{ background: deptColor(d.colorSlot) }} />
                  {deptName(d, lang)}
                  <span className="muted num">{items.length}</span>
                </span>
                <div className="health-strip" style={{ height: 14 }} role="img" aria-label={ORDER.map((h) => `${t(`health_${h}`)} ${items.filter((p) => p.health === h).length}`).join(', ')}>
                  {ORDER.map((h) => {
                    const n = items.filter((p) => p.health === h).length;
                    return n ? <span key={h} title={`${t(`health_${h}`)}: ${n}`} style={stagger(di + ORDER.indexOf(h), { flex: n, background: COLOR[h] })} /> : null;
                  })}
                </div>
                <span className="num ink-2" style={{ textAlign: 'end' }}>
                  {dAvg}%
                </span>
              </div>
            );
          })}
        </div>

        <h2>{t('needsAttention')}</h2>
        {attention.length === 0 ? (
          <p className="muted">{t('nothingNeedsAttention')}</p>
        ) : (
          <div className="attention">
            {attention.map((p) => {
              const u = latest.get(p.id);
              const exp = expectedProgress(p.startDate, p.endDate, today);
              const slip = p.baselineEnd ? diffDays(p.baselineEnd, p.endDate) : 0;
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
                    {!u?.blockers && !p.blocker && !u?.decisions && !(!u && p.lastComment) && (
                      <span className="muted">{u ? u.accomplishments : t('noUpdateYet')}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="two-col">
          <section>
            <h2>{t('achieved')}</h2>
            {achieved.length === 0 ? (
              <p className="muted">{t('noneInWindow')}</p>
            ) : (
              <ul className="mlist">
                {achieved.map(({ m, p }) => (
                  <li key={m.id}>
                    <span className="num muted">{fmtDate(m.date, lang)}</span>
                    <span>
                      {m.name} <span className="code">{p.code}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2>{t('comingUp')}</h2>
            {upcoming.length === 0 ? (
              <p className="muted">{t('noneInWindow')}</p>
            ) : (
              <ul className="mlist">
                {upcoming.map(({ m, p }) => (
                  <li key={m.id}>
                    <span className="num muted">{fmtDate(m.date, lang)}</span>
                    <span>
                      {m.name} <span className="code">{p.code}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

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
                const slip = p.baselineEnd ? diffDays(p.baselineEnd, p.endDate) : 0;
                return (
                  <tr key={p.id}>
                    <td>
                      <span className="code">{p.code}</span> {projectName(p, lang)}
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
      </article>
    </>
  );
}
