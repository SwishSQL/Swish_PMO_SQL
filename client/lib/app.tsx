import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Department, Meta, Permission, User } from '../../shared/types';
import { confirmLeave, hasUnsaved } from './unsaved';

// ---- Hash router ------------------------------------------------------------
// '#/projects/12/plan' -> ['projects', '12', 'plan']. A hash keeps deep links
// working behind any static host without server rewrites.

function readHash(): string[] {
  return window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    let passing = false;
    const on = async (e: HashChangeEvent) => {
      if (passing || !hasUnsaved()) {
        passing = false;
        setRoute(readHash());
        return;
      }
      // Back to where it was while the person decides; on with the move only if they let it go.
      const to = window.location.hash;
      window.history.replaceState(null, '', e.oldURL);
      if (!(await confirmLeave())) return;
      passing = true;
      window.location.hash = to;
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}

// ---- App data ---------------------------------------------------------------

interface AppState {
  meta: Meta;
  reloadMeta: () => Promise<void>;
  user: (id: number | null | undefined) => User | undefined;
  dept: (id: number | null | undefined) => Department | undefined;
  quarterId: number | null;
  setQuarterId: (id: number) => void;
  /** The signed-in person's role allows this. The server checks it again on every call. */
  can: (perm: Permission) => boolean;
  roleName: (roleId: string | undefined, lang: 'en' | 'ar') => string;
  /** Edit rights on one project: edit-all, or edit-own and on its team (the owner and the department head count). */
  canEditProject: (managerId: number | null, memberIds: number[], departmentId?: number) => boolean;
  /** Owner, team, stage, budget, dates, planning: edit-all, or edit-own and the project's owner or its department head. */
  canGovernProject: (managerId: number | null, departmentId?: number) => boolean;
  /** Departments this person heads. */
  headsDepartment: (departmentId: number | undefined) => boolean;
  /** Who may start a project in this department: the PMO, the company owner, or its head. */
  canCreateIn: (departmentId: number) => boolean;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside provider');
  return ctx;
}

export function AppProvider({
  meta,
  reloadMeta,
  children,
}: {
  meta: Meta;
  reloadMeta: () => Promise<void>;
  children: ReactNode;
}) {
  const [quarterId, setQuarterIdState] = useState<number | null>(() => {
    const saved = Number(safeGet('pmo.quarter'));
    return meta.quarters.some((q) => q.id === saved) ? saved : meta.currentQuarterId;
  });
  const setQuarterId = useCallback((id: number) => {
    setQuarterIdState(id);
    safeSet('pmo.quarter', String(id));
  }, []);
  const value = useMemo<AppState>(() => {
    const users = new Map(meta.users.map((u) => [u.id, u]));
    const depts = new Map(meta.departments.map((d) => [d.id, d]));
    const roles = new Map(meta.roles.map((r) => [r.id, r]));
    const perms = new Set(meta.permissions);
    const can = (p: Permission) => perms.has(p);
    return {
      meta,
      reloadMeta,
      user: (id) => (id ? users.get(id) : undefined),
      dept: (id) => (id ? depts.get(id) : undefined),
      quarterId,
      setQuarterId,
      can,
      roleName: (id, lang) => {
        const r = id ? roles.get(id) : undefined;
        return r ? (lang === 'ar' && r.nameAr ? r.nameAr : r.name) : '';
      },
      headsDepartment: (departmentId) => departmentId !== undefined && meta.departments.some((d) => d.id === departmentId && d.headUserId === meta.me.id),
      canEditProject: (managerId, memberIds, departmentId) =>
        can('projects.edit_all') ||
        (can('projects.edit_own') &&
          (managerId === meta.me.id || memberIds.includes(meta.me.id) || meta.departments.some((d) => d.id === departmentId && d.headUserId === meta.me.id))),
      canGovernProject: (managerId, departmentId) =>
        can('projects.edit_all') ||
        (can('projects.edit_own') &&
          (managerId === meta.me.id || meta.departments.some((d) => d.id === departmentId && d.headUserId === meta.me.id))),
      canCreateIn: (departmentId) =>
        can('projects.edit_all') ||
        can('projects.assign') ||
        (can('projects.create') && meta.departments.some((d) => d.id === departmentId && d.headUserId === meta.me.id)),
    };
  }, [meta, reloadMeta, quarterId, setQuarterId]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ---- Toasts -----------------------------------------------------------------

type Toast = { id: number; text: string; tone: 'ok' | 'bad' };
const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 6000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ---- Storage (per-viewer conveniences only) ---------------------------------

export function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

// ---- Data hook --------------------------------------------------------------

// Pages the person has already opened show at once from memory and refresh behind the scenes, so
// going back to a page is instant instead of a skeleton and a wait. Cleared on sign-out.
const loadCache = new Map<string, unknown>();
export function clearLoadCache(): void {
  loadCache.clear();
}

/**
 * key: opt in to the memory cache (the same string for the same data). Without it the page loads as before.
 * Writes through setData update the cache too, so an edit is what you see when you come back.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], key?: string) {
  const cacheKey = key === undefined ? undefined : `${key}|${deps.join(',')}`;
  const [data, setDataState] = useState<T | null>(() => (cacheKey !== undefined && loadCache.has(cacheKey) ? (loadCache.get(cacheKey) as T) : null));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const keyRef = useRef(cacheKey);
  keyRef.current = cacheKey;
  const setData = useCallback((next: T | null | ((d: T | null) => T | null)) => {
    setDataState((d) => {
      const v = typeof next === 'function' ? (next as (d: T | null) => T | null)(d) : next;
      if (keyRef.current !== undefined && v !== null) loadCache.set(keyRef.current, v);
      return v;
    });
  }, []);
  useEffect(() => {
    let live = true;
    setError(null);
    // The inputs changed (another project, another quarter): show what we have for them, or nothing.
    if (cacheKey !== undefined && loadCache.has(cacheKey)) setDataState(loadCache.get(cacheKey) as T);
    else if (cacheKey !== undefined) setDataState(null);
    load()
      .then((d) => {
        if (!live) return;
        if (cacheKey !== undefined) loadCache.set(cacheKey, d);
        setDataState(d);
      })
      .catch((e) => live && setError(e.message ?? String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, setData, error, reload };
}
