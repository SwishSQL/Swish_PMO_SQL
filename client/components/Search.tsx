import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowElbowDownLeft, Diamond, FolderSimple, MagnifyingGlass } from '@phosphor-icons/react';
import type { Health } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDate, projectName } from '../lib/format';
import { EASE_OUT } from '../lib/motion';
import { HealthBadge } from './ui';

interface Found {
  projects: { id: number; code: string; name: string; nameAr: string | null; health: Health; archived: boolean }[];
  milestones: { id: number; projectId: number; projectCode: string; code: string | null; name: string; date: string; status: string; ownerName: string | null }[];
}
export interface PageLink {
  key: string;
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}
type Item = { key: string; href: string; group: 'pages' | 'projects' | 'milestones'; render: () => ReactElement };

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The search box in the sidebar, and Ctrl+K (Cmd+K on a Mac) from anywhere. */
export function SearchButton({ pages }: { pages: PageLink[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <button className="search-trigger" onClick={() => setOpen(true)} aria-label={t('searchAll')} title={t('searchAll')} aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}>
        <MagnifyingGlass size={16} aria-hidden />
        <span>{t('searchAll')}</span>
        <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <AnimatePresence>{open && <Palette pages={pages} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function Palette({ pages, onClose }: { pages: PageLink[]; onClose: () => void }) {
  const { t, lang } = useT();
  const { meta } = useApp();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const query = q.trim();

  // A short pause after typing before asking, and only the latest answer counts.
  useEffect(() => {
    if (query.length < 2) {
      setFound(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .get<Found>(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => live && setFound(r))
        .catch(() => live && setFound({ projects: [], milestones: [] }));
    }, 140);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const items: Item[] = useMemo(() => {
    const needle = query.toLowerCase();
    const pageItems = pages
      .filter((p) => !needle || p.label.toLowerCase().includes(needle))
      .map<Item>((p) => ({
        key: `page-${p.key}`,
        href: p.href,
        group: 'pages',
        render: () => (
          <>
            <span className="srch-icon">
              <p.icon size={16} aria-hidden />
            </span>
            <span className="srch-main">{p.label}</span>
          </>
        ),
      }));
    const projects = (found?.projects ?? []).map<Item>((p) => ({
      key: `p-${p.id}`,
      href: `#/projects/${p.id}`,
      group: 'projects',
      render: () => (
        <>
          <span className="srch-icon">
            <FolderSimple size={16} aria-hidden />
          </span>
          <span className="srch-main">
            <span className="clamp-1" dir="auto">{projectName(p, lang)}</span>
            <span className="srch-sub code">
              {p.code}
              {p.archived ? ` · ${t('searchArchived')}` : ''}
            </span>
          </span>
          <HealthBadge health={p.health} />
        </>
      ),
    }));
    const milestones = (found?.milestones ?? []).map<Item>((m) => {
      const closed = m.status === 'done' || m.status === 'cancelled';
      const late = !closed && m.date < meta.today;
      return {
        key: `m-${m.id}`,
        href: `#/projects/${m.projectId}/plan?task=${m.id}`,
        group: 'milestones',
        render: () => (
          <>
            <span className="srch-icon">
              <Diamond size={15} weight={closed ? 'fill' : 'regular'} aria-hidden />
            </span>
            <span className="srch-main">
              <span className="clamp-1" dir="auto">{m.name}</span>
              <span className="srch-sub">
                <span className="code">{m.code ?? m.projectCode}</span>
                {m.ownerName ? ` · ${m.ownerName}` : ''}
              </span>
            </span>
            <span className={`srch-date num ${late ? 'late' : ''}`}>{closed ? t(`status_${m.status}` as never) : fmtDate(m.date, lang)}</span>
          </>
        ),
      };
    });
    return [...projects, ...milestones, ...pageItems];
  }, [found, pages, query, lang, t, meta.today]);

  useEffect(() => setActive(0), [items.length, query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    window.location.hash = item.href.slice(1);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const heads: Record<Item['group'], string> = { projects: t('searchProjects'), milestones: t('milestonesPage'), pages: t('searchPages') };
  const searching = query.length >= 2 && found === null;
  const nothing = query.length >= 2 && found !== null && items.length === 0;
  let lastGroup = '';
  return createPortal(
    <motion.div
      className="srch-scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="srch"
        role="dialog"
        aria-modal="true"
        aria-label={t('searchAll')}
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.22, ease: EASE_OUT }}
      >
        <div className="srch-input">
          <MagnifyingGlass size={18} aria-hidden />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('searchPlaceholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="srch-list"
            aria-activedescendant={items[active] ? `srch-${items[active].key}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="srch-list" id="srch-list" role="listbox" ref={listRef}>
          {searching && <div className="srch-empty muted">{t('searching')}</div>}
          {nothing && <div className="srch-empty muted">{t('searchNothing', { q: query })}</div>}
          {items.map((item, i) => {
            const head = item.group !== lastGroup ? heads[item.group] : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {head && <div className="srch-head">{head}</div>}
                <div
                  id={`srch-${item.key}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  className={`srch-item ${i === active ? 'on' : ''}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => go(item)}
                >
                  {item.render()}
                  {i === active && <ArrowElbowDownLeft className="srch-enter" size={14} aria-hidden />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="srch-foot muted">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t('searchMove')}
          </span>
          <span>
            <kbd>Enter</kbd> {t('searchOpen')}
          </span>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
