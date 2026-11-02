import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, BellRinging, CalendarX, Checks, Megaphone, SealCheck, Siren, UserPlus, X } from '@phosphor-icons/react';
import { api } from '../api';
import { useRoute } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate, fmtDateTime } from '../lib/format';
import { EASE_OUT } from '../lib/motion';
import { Drawer } from './ui';

interface Notification {
  id: number;
  kind: string;
  projectId: number | null;
  projectCode: string | null;
  taskId: number | null;
  data: Record<string, any>;
  createdAt: string;
  read: boolean;
}

const POLL_MS = 60_000;

/** The bell in the sidebar: unread count, and the list in a drawer. */
export function NotificationBell() {
  const { t } = useT();
  const route = useRoute();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setUnread((await api.get<{ unread: number }>('/api/notifications/count')).unread);
    } catch {
      /* signed out or offline: the count waits for the next tick */
    }
  }, []);

  // On arrival, every minute, when the tab comes back into view, and after moving between pages.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    const onFocus = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    refresh();
  }, [route.join('/'), refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button
        className="btn btn-ghost btn-sm btn-icon bell"
        onClick={() => setOpen(true)}
        aria-label={unread ? t('notificationsUnread', { n: unread }) : t('notifications')}
        title={t('notifications')}
      >
        {unread ? <BellRinging size={17} weight="fill" /> : <Bell size={17} />}
        <AnimatePresence>
          {unread > 0 && (
            <motion.span
              className="bell-count num"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ duration: 0.25, ease: EASE_OUT }}
            >
              {unread > 99 ? '99+' : unread}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
      {open && <NotificationsDrawer onClose={() => setOpen(false)} onCount={setUnread} />}
    </>
  );
}

function NotificationsDrawer({ onClose, onCount }: { onClose: () => void; onCount: (n: number) => void }) {
  const { t, lang } = useT();
  const [list, setList] = useState<Notification[] | null>(null);
  const [mailPref, setMailPref] = useState<{ enabled: boolean; available: boolean } | null>(null);

  useEffect(() => {
    api.get<Notification[]>('/api/notifications').then(setList).catch(() => setList([]));
    api.get<{ enabled: boolean; available: boolean }>('/api/notifications/email').then(setMailPref).catch(() => undefined);
  }, []);

  const toggleMail = async (enabled: boolean) => {
    setMailPref((m) => (m ? { ...m, enabled } : m));
    try {
      setMailPref(await api.put<{ enabled: boolean; available: boolean }>('/api/notifications/email', { enabled }));
    } catch {
      setMailPref((m) => (m ? { ...m, enabled: !enabled } : m));
    }
  };

  const markRead = async (ids?: number[]) => {
    const r = await api.post<{ unread: number }>('/api/notifications/read', ids ? { ids } : {});
    onCount(r.unread);
    setList((l) => l?.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)) ?? l);
  };

  const open = async (n: Notification) => {
    if (!n.read) await markRead([n.id]);
    onClose();
    window.location.hash = link(n);
  };

  const unread = list?.filter((n) => !n.read).length ?? 0;
  return (
    <Drawer onClose={onClose} label={t('notifications')}>
      <div className="dialog-head" style={{ paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
        <h2 className="dialog-title">{t('notifications')}</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {unread > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => markRead()}>
              <Checks size={15} aria-hidden />
              {t('markAllRead')}
            </button>
          )}
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={t('close')}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="dialog-body" style={{ flex: 1 }}>
        {list === null ? (
          <div className="skeleton" style={{ height: 240, borderRadius: 12 }} />
        ) : list.length === 0 ? (
          <div className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>
            {t('noNotifications')}
          </div>
        ) : (
          <ul className="notif-list">
            {list.map((n, i) => (
              <motion.li
                key={n.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: Math.min(i, 10) * 0.03, ease: EASE_OUT }}
              >
                <button className={`notif ${n.read ? '' : 'unread'}`} onClick={() => open(n)}>
                  <span className={`notif-icon k-${n.kind.split('.')[0]}`} aria-hidden>
                    {icon(n.kind)}
                  </span>
                  <span className="notif-body">
                    <span>{text(n, t, lang)}</span>
                    <span className="muted notif-meta">
                      {n.projectCode ? `${n.projectCode} · ` : ''}
                      {fmtDateTime(n.createdAt, lang)}
                    </span>
                  </span>
                </button>
              </motion.li>
            ))}
          </ul>
        )}
      </div>
      {mailPref?.available && (
        <label className="notif-mail" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 20px', borderTop: '1px solid var(--line)', fontSize: 13 }}>
          <input type="checkbox" checked={mailPref.enabled} onChange={(e) => toggleMail(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            {t('emailMeWork')}
            <span className="muted" style={{ display: 'block', fontSize: 12 }}>{t('emailMeWorkHint')}</span>
          </span>
        </label>
      )}
    </Drawer>
  );
}

function icon(kind: string) {
  if (kind.startsWith('deadline.')) return <CalendarX size={16} />;
  if (kind === 'escalation.raised') return <Siren size={16} />;
  if (kind === 'team.added' || kind === 'task.assigned' || kind === 'project.assigned' || kind === 'project.owner') return <UserPlus size={16} />;
  if (kind.startsWith('closure.') || kind.startsWith('change.')) return <SealCheck size={16} />;
  return <Megaphone size={16} />;
}

/** Where a notification takes you. */
function link(n: Notification): string {
  if (n.kind === 'reminder.daily') return '#/my-work';
  if (n.kind === 'reminder.weekly') return '#/updates';
  if (n.kind.startsWith('change.') && n.projectId) return `#/projects/${n.projectId}/changes`;
  if (n.projectId && n.taskId) return `#/projects/${n.projectId}/plan?task=${n.taskId}`;
  if (n.projectId) return `#/projects/${n.projectId}/plan`;
  return '#/dashboard';
}

type T = ReturnType<typeof useT>['t'];
function text(n: Notification, t: T, lang: 'en' | 'ar'): string {
  const raw: Record<string, any> = n.data ?? {};
  // Names are mostly English inside Arabic sentences: isolating each keeps it whole, in its own direction.
  const iso = (s: unknown) => `⁨${s ?? ''}⁩`;
  const d: Record<string, any> = { ...raw, by: iso(raw.by), to: iso(raw.to), reason: iso(raw.reason), project: iso(raw.project) };
  const name = iso(`"${raw.name ?? ''}"`);
  switch (n.kind) {
    case 'deadline.pending':
      return t('n_deadlinePending', { by: d.by, name, from: fmtDate(raw.from, lang), to: fmtDate(raw.to, lang), reason: d.reason });
    case 'deadline.decided':
      return t(d.decision === 'approve' ? 'n_deadlineApproved' : 'n_deadlineRejected', { by: d.by, name, to: fmtDate(raw.to, lang) });
    case 'escalation.raised':
      return t('n_escalation', { by: d.by, name, to: d.to, level: d.level });
    case 'task.assigned':
      return t('n_assigned', { by: d.by, name });
    case 'team.added':
      return t('n_teamAdded', { by: d.by, project: d.project });
    case 'project.assigned':
      return t('n_projectAssigned', { by: d.by, project: d.project });
    case 'project.owner':
      return t('n_projectOwner', { by: d.by, project: d.project });
    case 'change.pending':
      return t('n_changePending', { by: d.by, code: raw.code ?? '', name });
    case 'change.decided':
      return t(d.decision === 'approve' ? 'n_changeApproved' : 'n_changeRejected', { by: d.by, code: raw.code ?? '', name });
    case 'closure.requested':
      return t('n_closureRequested', { by: d.by, name });
    case 'closure.decided':
      return t(d.decision === 'approve' ? 'n_closureApproved' : 'n_closureRejected', { by: d.by, name });
    case 'reminder.daily': {
      const parts = [
        d.overdue ? t('n_partOverdue', { n: d.overdue }) : '',
        d.soon ? t('n_partSoon', { n: d.soon }) : '',
        d.stale ? t('n_partStale', { n: d.stale }) : '',
      ].filter(Boolean);
      return t('n_daily', { parts: parts.join(lang === 'ar' ? '، ' : ', ') });
    }
    case 'reminder.weekly':
      return t('n_weekly', { n: d.count, codes: iso((raw.codes ?? []).join(', ')) });
    default:
      return n.kind;
  }
}
