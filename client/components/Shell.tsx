import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { useToast } from '../lib/app';
import { Dialog, Field } from './ui';
import { motion } from 'motion/react';
import {
  ChartLineUp,
  CheckSquare,
  FlagBanner,
  Gauge,
  List,
  Moon,
  NotePencil,
  ShieldCheck,
  SignOut,
  Sun,
  X,
  Translate,
  UsersThree,
  Path,
} from '@phosphor-icons/react';
import { diffDays, spanDays } from '../../shared/dates';
import { useApp } from '../lib/app';
import { useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/format';
import { MIN_PASSWORD } from '../../shared/permissions';
import { SPRING } from '../lib/motion';
import { Avatar, BrandMark } from './ui';
import { NotificationBell } from './Notifications';
import { SearchButton } from './Search';

/** Where today sits in the selected quarter: the one piece of chrome that is live. */
function QuarterPulse() {
  const { meta, quarterId } = useApp();
  const { t } = useT();
  const q = meta.quarters.find((x) => x.id === quarterId);
  if (!q) return null;
  const total = spanDays(q.startsOn, q.endsOn);
  const day = Math.max(0, Math.min(total, diffDays(q.startsOn, meta.today) + 1));
  const share = day / total;
  const W = 184;
  const x = 4 + share * (W - 8);
  // Month boundaries inside the quarter become stations on the line.
  const months = [1, 2].map((m) => {
    const d = new Date(Date.UTC(q.year, (q.q - 1) * 3 + m, 1)).toISOString().slice(0, 10);
    return 4 + (diffDays(q.startsOn, d) / total) * (W - 8);
  });
  return (
    <div className="qpulse" aria-label={`Q${q.q} ${q.year}: ${t('ofN', { i: day, n: total })}`}>
      <div className="qpulse-top">
        <strong>
          Q{q.q} {q.year}
        </strong>
        <span className="num">{t('ofN', { i: day, n: total })}</span>
      </div>
      <svg width="100%" height="14" viewBox={`0 0 ${W} 14`} preserveAspectRatio="none" aria-hidden>
        <line x1={4} x2={W - 4} y1={7} y2={7} stroke="rgb(255 255 255 / .14)" strokeWidth={3} strokeLinecap="round" />
        <motion.line
          x1={4}
          y1={7}
          y2={7}
          stroke="url(#qp-grad)"
          strokeWidth={3}
          strokeLinecap="round"
          initial={{ x2: 4 }}
          animate={{ x2: x }}
          transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
        />
        <defs>
          <linearGradient id="qp-grad" x1="0" x2="1">
            <stop offset="0" stopColor="var(--d1)" />
            <stop offset="1" stopColor="var(--d3)" />
          </linearGradient>
        </defs>
        {months.map((mx) => (
          <circle key={mx} cx={mx} cy={7} r={3} fill={mx <= x ? 'var(--d3)' : '#0f1318'} stroke={mx <= x ? '#0f1318' : 'rgb(255 255 255 / .3)'} strokeWidth={1.5} />
        ))}
        <circle className="live-dot" cx={x} cy={7} r={4} fill="var(--d3)" />
        <circle cx={x} cy={7} r={4} fill="#fff" stroke="var(--d3)" strokeWidth={2} />
      </svg>
    </div>
  );
}

/** Who I am, my role, and changing my own password. */
function AccountDialog({ onClose }: { onClose: () => void }) {
  const { meta, roleName, dept } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    if (next !== again) return setError(t('passwordsDiffer'));
    try {
      await api.post('/api/auth/password', { current, next });
      toast(t('passwordChanged'));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog
      title={t('myAccount')}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('close')}
          </button>
          <button className="btn btn-primary" disabled={!current || next.length < MIN_PASSWORD || !again} onClick={save}>
            {t('changePassword')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 20 }}>
        <Avatar user={meta.me} size="lg" />
        <div>
          <div style={{ fontWeight: 600 }}>{meta.me.name}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {meta.me.email}
          </div>
          <div className="code">
            {roleName(meta.me.roleId, lang)}
            {dept(meta.me.departmentId) ? ` / ${lang === 'ar' ? dept(meta.me.departmentId)!.nameAr : dept(meta.me.departmentId)!.name}` : ''}
          </div>
        </div>
      </div>
      {/* How the password was last set. A setup link someone else opened would show here. */}
      {meta.myPassword.setAt && (
        <p className={`account-pw-note ${meta.myPassword.viaLinkFrom ? 'via-link' : ''}`}>
          <ShieldCheck size={16} weight="fill" aria-hidden style={{ flex: 'none' }} />
          <span>
            {meta.myPassword.viaLinkFrom
              ? t('passwordSetByLink', { d: fmtDateTime(meta.myPassword.setAt, lang), name: meta.myPassword.viaLinkFrom })
              : t('passwordSetByMe', { d: fmtDateTime(meta.myPassword.setAt, lang) })}
          </span>
        </p>
      )}
      <div style={{ display: 'grid', gap: 14 }}>
        <Field label={t('currentPassword')}>
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t('newPassword')} hint={t('passwordRule')}>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t('confirmPassword')}>
          <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function Shell({
  route,
  children,
  theme,
  onTheme,
  onSignOut,
}: {
  route: string[];
  children: ReactNode;
  theme: 'light' | 'dark';
  onTheme: () => void;
  onSignOut: () => void;
}) {
  const { meta, can, roleName } = useApp();
  const { t, lang, setLang } = useT();
  const [account, setAccount] = useState(false);
  // On a phone the sidebar is a slim header and this is the menu that opens from it.
  const [menu, setMenu] = useState(false);
  const top = route[0] ?? 'portfolio';
  const links = [
    { key: 'portfolio', href: '#/portfolio', label: t('portfolio'), icon: Path, match: ['portfolio', 'projects'] },
    { key: 'updates', href: '#/updates', label: t('weeklyReview'), icon: NotePencil, match: ['updates'] },
  ];
  links.splice(1, 0, { key: 'dashboard', href: '#/dashboard', label: t('dashboard'), icon: Gauge, match: ['dashboard'] });
  links.push({ key: 'milestones', href: '#/milestones', label: t('milestonesPage'), icon: FlagBanner, match: ['milestones'] });
  if (can('report.view')) links.push({ key: 'report', href: '#/report', label: t('report'), icon: ChartLineUp, match: ['report'] });
  links.push({ key: 'my-work', href: '#/my-work', label: t('myWork'), icon: CheckSquare, match: ['my-work'] });
  if (meta.canManageUsers) {
    links.push({ key: 'people', href: '#/people', label: t('people'), icon: UsersThree, match: ['people'] });
  }
  const place = route.join('/');
  useEffect(() => setMenu(false), [place]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [menu]);
  return (
    <div className="shell">
      <a className="sr-only" href="#main">
        Skip to content
      </a>
      <nav className={`sidebar ${menu ? 'open' : ''}`} aria-label="Main">
        <a className="brand" href="#/portfolio">
          <BrandMark className="brand-mark" onDark />
          <span className="brand-name">
            SWiSH <span>PMO</span>
          </span>
        </a>
        <SearchButton pages={links} />
        <button
          className="btn btn-ghost btn-icon menu-toggle"
          onClick={() => setMenu((m) => !m)}
          aria-expanded={menu}
          aria-label={menu ? t('closeMenu') : t('openMenu')}
        >
          {menu ? <X size={20} /> : <List size={20} />}
        </button>
        {links.map((l) => {
          const active = l.match.includes(top);
          return (
            <a key={l.key} className="nav-link" href={l.href} aria-current={active ? 'page' : undefined}>
              {active && <motion.span layoutId="nav-pill" className="nav-pill" transition={SPRING} />}
              <l.icon size={18} weight={active ? 'fill' : 'regular'} aria-hidden />
              {l.label}
            </a>
          );
        })}
        <QuarterPulse />
        <div className="sidebar-foot">
          <div className="sidebar-tools">
            <NotificationBell />
            <button className="btn btn-ghost btn-sm tool-more" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} title={t('language')}>
              <Translate size={16} aria-hidden />
              {t('language')}
            </button>
            <button
              className="btn btn-ghost btn-sm btn-icon tool-more"
              onClick={onTheme}
              aria-label={theme === 'dark' ? t('light') : t('dark')}
              title={theme === 'dark' ? t('light') : t('dark')}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button className="btn btn-ghost btn-sm btn-icon tool-more" onClick={onSignOut} aria-label={t('signOut')} title={t('signOut')}>
              <SignOut size={16} />
            </button>
          </div>
          <button className="me" onClick={() => setAccount(true)} title={t('myAccount')}>
            <Avatar user={meta.me} />
            <div className="me-text">
              <div className="me-name">{meta.me.name}</div>
              <div className="me-role">{roleName(meta.me.roleId, lang)}</div>
            </div>
          </button>
        </div>
      </nav>
      {account && <AccountDialog onClose={() => setAccount(false)} />}
      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}
