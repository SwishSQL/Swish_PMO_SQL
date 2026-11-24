import { useRef, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import type { Task } from '../../shared/types';
import { addDays, weekStart } from '../../shared/dates';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate, relativeDays } from '../lib/format';
import { Empty, ErrorState, PageSkeleton } from '../components/ui';
import { stagger } from '../lib/motion';
import { MsLegend, MsPill, milestoneTone } from '../lib/milestoneTone';
import { ALL_DATES, DateRange, inRange } from '../components/DateRange';
import { TaskPanelHost } from '../components/TaskPanelHost';
import type { Range } from '../components/DateRange';
import { LearnMore } from '../components/Tour';

type WorkItem = Task & { projectCode: string; projectName: string; projectNameAr: string | null; role: 'owner' | 'coOwner' };

export function MyWork() {
  const { meta } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const { data, setData, error, reload } = useLoad(() => api.get<WorkItem[]>('/api/my-work'), []);
  const before = useRef(new Map<number, Pick<Task, 'status' | 'progress'>>());
  const [dates, setDates] = useState<Range>(ALL_DATES);
  // The item open in the side panel, right here: updated without leaving My work.
  const [opened, setOpened] = useState<{ item: WorkItem; preset?: 'done' | 'reopen' } | null>(null);
  const [allDone, setAllDone] = useState(false);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;

  const today = meta.today;
  const weekEnd = addDays(weekStart(today), 6);
  // Done means status done, the same rule the Milestones page and the
  // project % use. Cancelled items never reach this page.
  const isDone = (x: WorkItem) => x.status === 'done';
  const shown = data.filter((x) => inRange(x.endDate, dates));
  const open = shown.filter((x) => !isDone(x));
  const completed = shown.filter(isDone).sort((a, b) => b.endDate.localeCompare(a.endDate) || b.id - a.id);
  const groups: [string, WorkItem[]][] = [
    [t('overdue'), open.filter((x) => x.endDate < today)],
    [t('thisWeek'), open.filter((x) => x.endDate >= today && x.endDate <= weekEnd)],
    [t('later'), open.filter((x) => x.endDate > weekEnd)],
    // The most recent first: the 12 latest show, the rest on request.
    [t('completed'), completed.slice(0, allDone ? undefined : 12)],
  ];

  // Ticking sets the status itself, so a blocked item really closes
  // everywhere, not just here. Unticking a tick made on this page puts back
  // the status and % it had. Otherwise it reopens at 0%.
  // A plain task ticks at once.
  // A milestone opens its panel ready to post the completion (or the reopening) as an update, in its history.
  const tick = (item: WorkItem) => (item.kind === 'milestone' ? setOpened({ item, preset: isDone(item) ? 'reopen' : 'done' }) : complete(item));
  const complete = async (item: WorkItem, note = '') => {
    let patch: Partial<Task> & { updateComment?: string };
    if (isDone(item)) {
      patch = before.current.get(item.id) ?? { status: 'todo', progress: 0 };
      before.current.delete(item.id);
    } else {
      before.current.set(item.id, { status: item.status, progress: item.progress });
      patch = { status: 'done', progress: 100, ...(note ? { updateComment: note } : {}) };
    }
    const { updateComment: _, ...shown } = patch;
    setData((d) => d?.map((x) => (x.id === item.id ? { ...x, ...shown } : x)) ?? d);
    try {
      await api.patch(`/api/tasks/${item.id}`, patch);
    } catch (e) {
      toast((e as Error).message, 'bad');
      reload();
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('myWork')}</h1>
          <LearnMore page="mywork" />
          <p className="page-sub">{meta.me.name}</p>
        </div>
        <div className="toolbar">
          <DateRange value={dates} onChange={setDates} today={today} />
        </div>
      </div>
      {opened && <TaskPanelHost key={`${opened.item.id}-${opened.preset ?? ''}`} projectId={opened.item.projectId} taskId={opened.item.id} preset={opened.preset} onClose={() => setOpened(null)} onChanged={reload} />}
      {data.some((x) => x.kind === 'milestone') && <MsLegend />}
      {data.length === 0 ? (
        <div className="panel">
          <Empty title={t('myWorkEmpty')} body={t('myWorkEmptyBody')} />
        </div>
      ) : (
        groups
          .filter(([, items]) => items.length > 0)
          .map(([label, items]) => (
            <section key={label} className="work-group">
              <h3>
                {label} <span className="muted num">{label === t('completed') ? completed.length : items.length}</span>
              </h3>
              <div className="panel">
                {items.map((x, i) => {
                  const done = isDone(x);
                  const late = !done && x.endDate < today;
                  const tone = x.kind === 'milestone' ? milestoneTone({ ...x, date: x.endDate }, today) : null;
                  return (
                    <div key={x.id} className={`work-item enter ${tone ? `ms-stripe ms-tone-${tone}` : ''}`} style={stagger(i)}>
                      <button
                        className="check"
                        role="checkbox"
                        aria-checked={done}
                        aria-label={t('markDone')}
                        onClick={() => tick(x)}
                      >
                        <Check size={13} weight="bold" />
                      </button>
                      <div style={{ minWidth: 0 }}>
                        <div
                          className="work-open"
                          role="button"
                          tabIndex={0}
                          onClick={() => setOpened({ item: x })}
                          onKeyDown={(e) => e.key === 'Enter' && setOpened({ item: x })}
                          style={{ fontWeight: 500, textDecoration: done ? 'line-through' : undefined, color: done ? 'var(--ink-3)' : undefined }}
                        >
                          {x.name}
                          {x.role === 'coOwner' && <span className="flag-chip" style={{ marginInlineStart: 8 }}>{t('coOwnerBadge')}</span>}
                        </div>
                        <a className="code" href={`#/projects/${x.projectId}/plan?task=${x.id}`} title={t('openInPlan')}>
                          {x.projectCode} {lang === 'ar' && x.projectNameAr ? x.projectNameAr : x.projectName}
                        </a>
                      </div>
                      {tone ? (
                        <MsPill tone={tone} progress={x.progress} />
                      ) : (
                        <span className="num ink-2" style={{ fontSize: 13 }}>
                          {x.progress}%
                        </span>
                      )}
                      <span className="num" style={{ fontSize: 13, color: late ? 'var(--bad)' : 'var(--ink-2)', minWidth: 110, textAlign: 'end' }}>
                        {fmtDate(x.endDate, lang)}
                        <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                          {relativeDays(x.endDate, today, lang)}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
              {label === t('completed') && completed.length > 12 && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setAllDone(!allDone)}>
                  {allDone ? t('showLess') : t('showAllN', { n: completed.length })}
                </button>
              )}
            </section>
          ))
      )}
    </>
  );
}
