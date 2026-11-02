import { useRef } from 'react';
import { Check } from '@phosphor-icons/react';
import type { Task } from '../../shared/types';
import { addDays, weekStart } from '../../shared/dates';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate, relativeDays } from '../lib/format';
import { Empty, ErrorState, PageSkeleton } from '../components/ui';
import { stagger } from '../lib/motion';

type WorkItem = Task & { projectCode: string; projectName: string; projectNameAr: string | null; role: 'owner' | 'coOwner' };

export function MyWork() {
  const { meta } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const { data, setData, error, reload } = useLoad(() => api.get<WorkItem[]>('/api/my-work'), []);
  const before = useRef(new Map<number, Pick<Task, 'status' | 'progress'>>());

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;

  const today = meta.today;
  const weekEnd = addDays(weekStart(today), 6);
  // Done means status done, the same rule the Milestones page and the
  // project % use. Cancelled items never reach this page.
  const isDone = (x: WorkItem) => x.status === 'done';
  const open = data.filter((x) => !isDone(x));
  const groups: [string, WorkItem[]][] = [
    [t('overdue'), open.filter((x) => x.endDate < today)],
    [t('thisWeek'), open.filter((x) => x.endDate >= today && x.endDate <= weekEnd)],
    [t('later'), open.filter((x) => x.endDate > weekEnd)],
    [t('completed'), data.filter(isDone).slice(0, 12)],
  ];

  // Ticking sets the status itself, so a blocked item really closes
  // everywhere, not just here. Unticking a tick made on this page puts back
  // the status and % it had. Otherwise it reopens at 0%.
  const complete = async (item: WorkItem) => {
    let patch: Partial<Task>;
    if (isDone(item)) {
      patch = before.current.get(item.id) ?? { status: 'todo', progress: 0 };
      before.current.delete(item.id);
    } else {
      before.current.set(item.id, { status: item.status, progress: item.progress });
      patch = { status: 'done', progress: 100 };
    }
    setData((d) => d?.map((x) => (x.id === item.id ? { ...x, ...patch } : x)) ?? d);
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
          <p className="page-sub">{meta.me.name}</p>
        </div>
      </div>
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
                {label} <span className="muted num">{items.length}</span>
              </h3>
              <div className="panel">
                {items.map((x, i) => {
                  const done = isDone(x);
                  const late = !done && x.endDate < today;
                  return (
                    <div key={x.id} className="work-item enter" style={stagger(i)}>
                      <button
                        className="check"
                        role="checkbox"
                        aria-checked={done}
                        aria-label={t('markDone')}
                        onClick={() => complete(x)}
                      >
                        <Check size={13} weight="bold" />
                      </button>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500, textDecoration: done ? 'line-through' : undefined, color: done ? 'var(--ink-3)' : undefined }}>
                          {x.name}
                          {x.role === 'coOwner' && <span className="flag-chip" style={{ marginInlineStart: 8 }}>{t('coOwnerBadge')}</span>}
                        </div>
                        <a className="code" href={`#/projects/${x.projectId}/plan`}>
                          {x.projectCode} {lang === 'ar' && x.projectNameAr ? x.projectNameAr : x.projectName}
                        </a>
                      </div>
                      <span className="num ink-2" style={{ fontSize: 13 }}>
                        {x.progress}%
                      </span>
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
            </section>
          ))
      )}
    </>
  );
}
