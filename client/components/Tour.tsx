import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Info } from '@phosphor-icons/react';
import { api } from '../api';
import { useApp } from '../lib/app';
import { LEADS_PROJECTS } from '../../shared/permissions';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { PAGE_STEPS, type PageTourId } from '../lib/pageTours';

// Guided tours, in the language the person uses:
// - the role tour: a few steps on where things are, opened by itself the first time;
// - page guides: each page (and the milestone panel) walks through its own fields and buttons, only when the person
//   clicks Learn more there, once per click.

export type TourRole = 'member' | 'pm' | 'head' | 'manager' | 'pmo' | 'exec';
type Step = { sel?: string; k: string };

const ROLE_STEPS: Record<TourRole, Step[]> = {
  member: [{ k: 'welcome' }, { sel: 'a[href="#/my-work"]', k: 'mywork' }, { k: 'update' }, { k: 'mention' }, { k: 'escalate' }, { sel: '[data-tour="bell"]', k: 'bell' }, { sel: '[data-tour="lang"]', k: 'lang' }],
  pm: [{ k: 'welcome' }, { sel: '.home-summary', k: 'summary' }, { sel: 'a[href="#/milestones"]', k: 'milestones' }, { sel: 'a[href="#/updates"]', k: 'standup' }, { k: 'plan' }, { k: 'ai' }, { sel: '[data-tour="bell"]', k: 'bell' }],
  head: [{ k: 'welcome' }, { sel: '.home-summary', k: 'summary' }, { k: 'owners' }, { k: 'approve' }, { sel: 'a[href="#/dashboard"]', k: 'dashboard' }, { sel: '[data-tour="bell"]', k: 'bell' }],
  manager: [{ k: 'welcome' }, { sel: '.home-summary', k: 'summary' }, { k: 'plan' }, { k: 'escalations' }, { sel: '[data-tour="bell"]', k: 'bell' }],
  pmo: [{ k: 'welcome' }, { sel: 'a[href="#/dashboard"]', k: 'dashboard' }, { sel: 'a[href="#/report"]', k: 'report' }, { sel: 'a[href="#/insights"]', k: 'insights' }, { sel: 'a[href="#/people"]', k: 'people' }, { k: 'viewas' }],
  exec: [{ k: 'welcome' }, { sel: '.home-summary', k: 'summary' }, { sel: 'a[href="#/report"]', k: 'report' }, { k: 'ask' }, { k: 'escalations' }],
};

export function useTourRole(): TourRole {
  const { meta, can } = useApp();
  if (can('projects.edit_all')) return 'pmo';
  if (can('projects.view_all')) return 'exec';
  if (meta.departments.some((d) => d.headUserId === meta.me.id)) return 'head';
  if (meta.managesPlan) return 'manager';
  if (LEADS_PROJECTS.some((p) => can(p))) return 'pm';
  return 'member';
}

let tourOpen = false;

type Ask = { page?: PageTourId; auto?: boolean };
const EVENT = 'pmo:tour';
const ask = (detail: Ask) => window.dispatchEvent(new CustomEvent<Ask>(EVENT, { detail }));

/** Help in the sidebar: the overview tour of the person's role. */
export function startTour(): void {
  ask({});
}

/** Learn more, at the top of a page (or the milestone panel): that page's guide, once per click. Page guides never
 * open by themselves. */
export function LearnMore({ page }: { page: PageTourId }) {
  const { t } = useT();
  return (
    <button type="button" className="btn btn-ghost btn-sm learn-more" onClick={() => ask({ page })}>
      <Info size={15} aria-hidden />
      {t('learnMore')}
    </button>
  );
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const visible = (sel: string) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
};

export function Tour() {
  const { meta } = useApp();
  const { t } = useT();
  const role = useTourRole();
  const [run, setRun] = useState<{ page?: PageTourId; steps: Step[] } | null>(null);
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(200);

  useEffect(() => {
    let cancelled = false;
    const open = async (e: Event) => {
      const { page, auto } = (e as CustomEvent<Ask>).detail ?? {};
      if (tourOpen) return;
      // The overview tour never opens over the Needs-your-action pop-up: it waits until that is closed.
      for (let i = 0; auto && i < 1200 && document.querySelector('.act-list'); i++) await sleep(500);
      if (cancelled || tourOpen) return;
      const all = page ? PAGE_STEPS[page] : ROLE_STEPS[role];
      // Pages load their data after they open: wait a little for the first pointed-at part.
      const sels = all.filter((s) => s.sel).map((s) => s.sel).join(',');
      for (let i = 0; sels && i < 20 && !document.querySelector(sels); i++) await sleep(250);
      if (cancelled) return;
      // Only what this person has on screen (someone who cannot edit has no update form, for example).
      const steps = all.filter((s) => !s.sel || visible(s.sel) || !page);
      if (!steps.length || (auto && tourOpen)) return;
      tourOpen = true;
      setAt(0);
      setRun({ page, steps });
    };
    window.addEventListener(EVENT, open);
    // The role tour, the first time in (not while viewing as someone).
    const first = !(meta.me as { tourDone?: boolean }).tourDone && !meta.viewingAs;
    const timer = first ? window.setTimeout(() => ask({ auto: true }), 1500) : undefined;
    return () => {
      cancelled = true;
      window.removeEventListener(EVENT, open);
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const step = run ? run.steps[at] : null;
  useLayoutEffect(() => {
    if (!step) return;
    const el = step.sel ? document.querySelector(step.sel) : null;
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const measure = () => setBox(el ? el.getBoundingClientRect() : null);
    measure();
    const raf = window.requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);
  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [step, box]);

  const finish = () => {
    const page = run?.page;
    setRun(null);
    tourOpen = false;
    // Finished, skipped or closed with Esc: the overview tour never opens by itself again.
    if (!page && !meta.viewingAs) void api.post('/api/me/tour-done', {}).catch(() => undefined);
  };
  useEffect(() => {
    if (!run) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  if (!run || !step) return null;
  const pad = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cw = Math.min(360, vw - 24);
  const rtl = document.dir === 'rtl';
  // The spotlight, kept on screen for parts taller or wider than the window.
  const spot = box
    ? (() => {
        const top = Math.max(4, box.top - pad);
        const left = Math.max(4, box.left - pad);
        return { top, left, width: Math.min(vw - 4, box.right + pad) - left, height: Math.min(vh - 4, box.bottom + pad) - top };
      })()
    : null;
  // The card goes beside the part where there is room, else below or above it, else at the bottom of the window.
  let card: React.CSSProperties;
  if (!spot) card = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  else {
    const clampTop = (y: number) => Math.max(12, Math.min(vh - cardH - 12, y));
    const clampLeft = (x: number) => Math.max(12, Math.min(vw - cw - 12, x));
    const right = vw - (spot.left + spot.width);
    const sides = rtl ? ['left', 'right'] : ['right', 'left'];
    const side = sides.find((s) => (s === 'right' ? right : spot.left) >= cw + 28);
    if (side === 'right') card = { top: clampTop(spot.top), left: spot.left + spot.width + 14 };
    else if (side === 'left') card = { top: clampTop(spot.top), left: spot.left - 14 - cw };
    else if (vh - (spot.top + spot.height) >= cardH + 24) card = { top: spot.top + spot.height + 12, left: clampLeft(rtl ? spot.left + spot.width - cw : spot.left) };
    else if (spot.top >= cardH + 24) card = { top: spot.top - 12 - cardH, left: clampLeft(rtl ? spot.left + spot.width - cw : spot.left) };
    else card = { top: vh - cardH - 16, left: clampLeft((vw - cw) / 2) };
  }
  const key = (part: 't' | 'b') => (run.page ? `ptour_${run.page}_${step.k}_${part}` : `tour_${role}_${step.k}_${part}`) as TKey;
  const last = at === run.steps.length - 1;
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={t('tour_title')}>
      {spot ? <div className="tour-spot" style={spot} /> : <div className="tour-dim" />}
      <div className="tour-card" style={{ ...card, width: cw }} ref={cardRef}>
        <div className="tour-count">{t('tour_step', { n: at + 1, of: run.steps.length })}</div>
        <strong>{t(key('t'))}</strong>
        <p>{t(key('b'))}</p>
        <div className="tour-actions">
          <button className="btn btn-ghost btn-sm" onClick={finish}>
            {t('tour_skip')}
          </button>
          {run.page && (
            <button className="btn btn-ghost btn-sm" onClick={() => (finish(), window.setTimeout(() => ask({}), 50))}>
              {t('tour_overview')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          {at > 0 && (
            <button className="btn btn-sm" onClick={() => setAt(at - 1)}>
              {t('tour_back')}
            </button>
          )}
          <button className="btn btn-primary btn-sm" autoFocus onClick={() => (last ? finish() : setAt(at + 1))}>
            {last ? t('tour_done') : t('tour_next')}
          </button>
        </div>
      </div>
    </div>
  );
}
