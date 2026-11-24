import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, CalendarCheck, Clock, CalendarX, FlagCheckered, At, Bell, GitPullRequest, PlayCircle, Siren, UserCircleDashed, UserPlus } from '@phosphor-icons/react';
import type { MyAction } from '../../shared/types';
import { api } from '../api';
import { navigate, useApp } from '../lib/app';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { Dialog } from './ui';
import { openTask } from './OpenTask';
import { fmtDate } from '../lib/format';
import { link as noteLink, text as noteText } from './Notifications';
import type { Notification } from './Notifications';

// "Needs your action": what waits for this person (escalations, approvals, plans to baseline).
// - It opens once per sign-in with everything; after that only when something new arrives, with the new items on
//   top and the earlier ones folded.
// - It is polite: never while the person is typing, editing in a panel or form, using the sidebar or clicking
//   around. Meanwhile the bell shows a dot and the items are listed in the notification center; the pop-up opens
//   once they pause.
// - "Remind me later" hides what is listed until tomorrow.

// Kept per person: hiding an item while viewing as someone, or on a shared computer, hides it for that person only.
const snoozeKey = (userId: number) => `pmo.actionsSnoozed.${userId}`;
const seenKey = (userId: number) => `pmo.actionsSeen.${userId}`;
const POLL_MS = 5 * 60_000;
/** Typing this recently, or clicking this recently, counts as busy. */
const TYPING_QUIET_MS = 20_000;
const CLICK_QUIET_MS = 6_000;

function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* kept for this visit only */
  }
}
const snoozed = (userId: number) => readJson<Record<string, string>>(snoozeKey(userId), {});
const today = () => new Date().toISOString().slice(0, 10);

const ICON = { escalation: Siren, date_change: CalendarX, change_request: GitPullRequest, closure: FlagCheckered, baseline: CalendarCheck, due: Clock, no_owner: UserCircleDashed, owner_request: UserPlus, can_start: PlayCircle, mention: At, note: Bell };

/** A notice in the pop-up, read the way the notification center reads it. */
function asNote(a: MyAction): Notification {
  return { id: a.noteId ?? 0, kind: a.noteKind ?? '', projectId: a.projectId, taskId: a.taskId ?? null, data: a.noteData ?? {}, read: false, createdAt: '' } as unknown as Notification;
}

function target(a: MyAction): string {
  switch (a.kind) {
    case 'escalation':
    case 'date_change':
    case 'due':
      return `/projects/${a.projectId}/plan?task=${a.taskId}`;
    case 'change_request':
      return `/projects/${a.projectId}/changes`;
    case 'closure':
      return `/projects/${a.projectId}/plan`;
    case 'baseline':
      return `/projects/${a.projectId}/plan?do=baseline`;
    case 'owner_request':
      return '/assignments';
    case 'can_start':
      return `/projects/${a.projectId}/plan`;
    case 'mention':
      return a.projectId ? `/projects/${a.projectId}/plan` : '/portfolio';
    case 'note':
      return noteLink(asNote(a)).replace(/^#/, '');
    case 'no_owner':
      return `/projects/${a.projectId}/plan`;
  }
}

/** Opening is not dismissing: until it is done, the item stays listed. */
function openAction(a: MyAction): void {
  // A milestone opens in its panel on top of this page; the rest go to their page. A mention is read once opened.
  if ((a.kind === 'mention' || a.kind === 'note') && a.noteId) void api.post('/api/notifications/read', { ids: [a.noteId] }).catch(() => undefined);
  if (a.kind === 'note' && a.taskId && a.projectId && !String(a.noteKind).startsWith('change.') && !String(a.noteKind).startsWith('closure.')) return openTask(a.projectId, a.taskId);
  if ((a.kind === 'escalation' || a.kind === 'date_change' || a.kind === 'due' || a.kind === 'mention') && a.taskId) return openTask(a.projectId, a.taskId);
  navigate(target(a));
}

// ---- What waits, shared with the bell ----------------------------------------------------------------------------
let current: { items: MyAction[]; waiting: boolean } = { items: [], waiting: false };
const subs = new Set<() => void>();
function publish(next: Partial<typeof current>): void {
  current = { ...current, ...next };
  subs.forEach((f) => f());
}
/** The items waiting for this person, and whether the pop-up is holding back new ones until they pause. */
export function useMyActions(): { items: MyAction[]; waiting: boolean } {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => current,
  );
}
/** Show the pop-up now, with everything (from the bell). */
export function showMyActions(): void {
  window.dispatchEvent(new Event('pmo:actions-open'));
}

// ---- Is the person busy? -------------------------------------------------------------------------------------------
const last = { typed: 0, clicked: 0 };
let watching = false;
function watchActivity(): void {
  if (watching) return;
  watching = true;
  const typed = () => (last.typed = Date.now());
  window.addEventListener('keydown', typed, true);
  window.addEventListener('input', typed, true);
  const clicked = () => (last.clicked = Date.now());
  window.addEventListener('pointerdown', clicked, true);
  window.addEventListener('wheel', clicked, { capture: true, passive: true });
}
function busy(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el?.matches('input, textarea, select, [contenteditable="true"]')) return true;
  // A panel, a form, the notification center or a guide is open, or the menu is open on a phone. (Using the sidebar
  // is clicking or scrolling, counted below.)
  if (document.querySelector('.dialog, .drawer, .tour, .sidebar.open, .search-pop')) return true;
  const now = Date.now();
  return now - last.typed < TYPING_QUIET_MS || now - last.clicked < CLICK_QUIET_MS;
}

// ---- The rows ------------------------------------------------------------------------------------------------------
function useActionText() {
  const { t, lang } = useT();
  return (a: MyAction) =>
    a.kind === 'escalation'
      ? t('act_escalation', { level: a.level ?? 1, days: a.days ?? 0 })
      : a.kind === 'baseline'
        ? t(a.first ? 'act_baselineFirst' : 'act_baseline', { n: a.count ?? 0 })
        : a.kind === 'note'
          ? noteText(asNote(a), t, lang)
        : a.kind === 'mention'
          ? t('act_mention', { by: a.by ?? '', excerpt: a.excerpt ?? '' })
        : a.kind === 'can_start'
          ? t('act_canStart')
        : a.kind === 'owner_request'
          ? t(a.date === 'new' ? 'act_ownerNew' : 'act_ownerReq')
        : a.kind === 'no_owner'
          ? t('act_noOwner', { n: a.count ?? 0 })
        : a.kind === 'due'
          ? (a.date ?? '') < new Date().toISOString().slice(0, 10)
            ? t('act_dueLate', { date: fmtDate(a.date ?? '', lang) })
            : t('act_dueSoon', { date: fmtDate(a.date ?? '', lang) })
        : t(`act_${a.kind}` as TKey, { date: a.date ?? '' });
}

/** The list of items, in the pop-up and in the notification center. */
export function ActionItems({ items, onOpen }: { items: MyAction[]; onOpen: (a: MyAction) => void }) {
  const { t, lang } = useT();
  const text = useActionText();
  return (
    <ul className="act-list">
      {items.map((a) => {
        const Icon = ICON[a.kind];
        return (
          <li key={a.key} className={`act-${a.kind}`}>
            <Icon size={20} weight="duotone" aria-hidden />
            <div>
              <span className="act-what">{text(a)}</span>
              <strong>{a.title}</strong>
              <span className="code">{a.projectCode}</span>
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => onOpen(a)}>
              {t('act_open')} <ArrowRight size={14} aria-hidden style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ActionPopup() {
  const { t } = useT();
  const { meta } = useApp();
  const me = meta.me.id;
  const session = (meta as { session?: string }).session ?? '';
  const [items, setItems] = useState<MyAction[]>([]);
  // What this pop-up shows when open: the new items in full, the ones already seen this sign-in folded.
  const [shown, setShown] = useState<{ fresh: string[] } | null>(null);
  const pending = useRef(false);

  // What was already shown in this sign-in (a new sign-in starts over).
  const seen = useCallback((): Set<string> => {
    const s = readJson<{ s: string; keys: string[] }>(seenKey(me), { s: '', keys: [] });
    return new Set(s.s === session ? s.keys : []);
  }, [me, session]);
  const markSeen = useCallback(
    (keys: string[]) => writeJson(seenKey(me), { s: session, keys: [...new Set([...seen(), ...keys])] }),
    [me, session, seen],
  );

  const load = useCallback(async () => {
    try {
      const all = await api.get<MyAction[]>('/api/my-actions');
      const later = snoozed(me);
      const due = all.filter((a) => !(later[a.key] && later[a.key] >= today()));
      setItems(due);
      const already = seen();
      pending.current = due.some((a) => !already.has(a.key));
      publish({ items: due, waiting: pending.current });
    } catch {
      /* not signed in yet, or offline: try again later */
    }
  }, [me, seen]);

  useEffect(() => {
    watchActivity();
    // Signing in is not "being busy": the first pop-up of a sign-in waits only for the page to settle.
    last.typed = 0;
    last.clicked = 0;
    void load();
    const poll = window.setInterval(load, POLL_MS);
    const onSaved = () => void load();
    window.addEventListener('pmo:saved', onSaved);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('pmo:saved', onSaved);
    };
  }, [load]);

  // New items wait until the person pauses.
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (!pending.current || shown || busy()) return;
      const already = seen();
      const fresh = items.filter((a) => !already.has(a.key)).map((a) => a.key);
      if (!fresh.length) return;
      markSeen(items.map((a) => a.key));
      pending.current = false;
      publish({ waiting: false });
      setShown({ fresh });
    }, 2000);
    return () => window.clearInterval(tick);
  }, [items, shown, seen, markSeen]);

  // From the bell: everything, now.
  useEffect(() => {
    const onOpen = () => {
      markSeen(items.map((a) => a.key));
      pending.current = false;
      publish({ waiting: false });
      setShown({ fresh: items.map((a) => a.key) });
    };
    window.addEventListener('pmo:actions-open', onOpen);
    return () => window.removeEventListener('pmo:actions-open', onOpen);
  }, [items, markSeen]);

  if (!shown || items.length === 0) return null;
  const fresh = items.filter((a) => shown.fresh.includes(a.key));
  const earlier = items.filter((a) => !shown.fresh.includes(a.key));

  const close = () => setShown(null);
  const later = () => {
    const s = snoozed(me);
    const until = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    for (const a of items) s[a.key] = until;
    writeJson(snoozeKey(me), s);
    close();
    void load();
  };
  const go = (a: MyAction) => {
    close();
    openAction(a);
  };

  return (
    <Dialog
      title={t('act_title', { n: fresh.length || items.length })}
      onClose={close}
      width={600}
      footer={
        <button className="btn" onClick={later}>
          {t('act_later')}
        </button>
      }
    >
      <ActionItems items={fresh.length ? fresh : items} onOpen={go} />
      {fresh.length > 0 && earlier.length > 0 && (
        <details className="act-earlier">
          <summary>{t('act_earlier', { n: earlier.length })}</summary>
          <ActionItems items={earlier} onOpen={go} />
        </details>
      )}
    </Dialog>
  );
}

/** In the notification center: the same items, to act on without waiting for the pop-up. */
export function ActionsInBell({ onOpened }: { onOpened: () => void }) {
  const { t } = useT();
  const { items } = useMyActions();
  if (!items.length) return null;
  return (
    <section className="act-in-bell">
      <h3>{t('act_title', { n: items.length })}</h3>
      <ActionItems
        items={items}
        onOpen={(a) => {
          onOpened();
          openAction(a);
        }}
      />
    </section>
  );
}
