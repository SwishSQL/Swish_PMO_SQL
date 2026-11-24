import '@fontsource/ibm-plex-sans/400.css';
import { LEADS_PROJECTS } from '../shared/permissions';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import './styles.css';
import { StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { EASE_OUT } from './lib/motion';
import { installTableSort } from './lib/tableSort';
import type { Meta } from '../shared/types';
import { api } from './api';
import { UnsavedPrompt } from './lib/unsaved';
import { AppProvider, ToastProvider, clearLoadCache, navigate, safeGet, safeSet, useRoute } from './lib/app';
import { LangContext, makeT } from './lib/i18n';
import type { Lang } from './lib/i18n';
import { Shell } from './components/Shell';
import { PageSkeleton } from './components/ui';
import { Login } from './pages/Login';
import { ChoosePassword } from './pages/ChoosePassword';
import { Portfolio } from './pages/Portfolio';
import { MyWork } from './pages/MyWork';
import { Assignments } from './pages/Assignments';
import { Insights } from './pages/Insights';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installFreshVersion, lazyPage } from './lib/fresh';

// Only the Portfolio, the sign-in and My work ride in the first download. The rest load the first
// time they are opened (the plan editor and the admin pages are the bulk of the code).
const ProjectPage = lazy(lazyPage(() => import('./pages/ProjectPage').then((m) => ({ default: m.ProjectPage }))));
const WeeklyReview = lazy(lazyPage(() => import('./pages/WeeklyReview').then((m) => ({ default: m.WeeklyReview }))));
const Report = lazy(lazyPage(() => import('./pages/Report').then((m) => ({ default: m.Report }))));
const Milestones = lazy(lazyPage(() => import('./pages/Milestones').then((m) => ({ default: m.Milestones }))));
const Dashboard = lazy(lazyPage(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard }))));
const People = lazy(lazyPage(() => import('./pages/People').then((m) => ({ default: m.People }))));

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function App() {
  const [lang, setLangState] = useState<Lang>(() => (safeGet('pmo.lang') === 'ar' ? 'ar' : 'en'));
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = safeGet('pmo.theme');
    return saved === 'dark' || saved === 'light' ? saved : systemTheme();
  });
  const [meta, setMeta] = useState<Meta | null>(null);
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');
  const route = useRoute();

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    safeSet('pmo.lang', l);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const reloadMeta = useCallback(async () => {
    try {
      setMeta(await api.get<Meta>('/api/meta'));
      setState('in');
    } catch {
      setState('out');
    }
  }, []);

  useEffect(() => {
    reloadMeta();
    // Whatever was cached belongs to the person who just left.
    const out = () => (clearLoadCache(), setState('out'));
    window.addEventListener('pmo:signed-out', out);
    return () => window.removeEventListener('pmo:signed-out', out);
  }, [reloadMeta]);

  const langValue = useMemo(() => ({ lang, t: makeT(lang), setLang }), [lang, setLang]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    safeSet('pmo.theme', next);
  };

  const signOut = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    clearLoadCache();
    setMeta(null);
    setState('out');
  };

  let body;
  if (route[0] === 'activate' && route[1]) {
    // A setup link works signed in or out: setting up signs in as that account.
    body = (
      <Login
        invite={route[1]}
        onSignedIn={() => {
          navigate('/portfolio');
          reloadMeta();
        }}
        onLeaveInvite={() => navigate('/portfolio')}
      />
    );
  } else if (state === 'loading') {
    body = (
      <div style={{ padding: 40 }}>
        <PageSkeleton />
      </div>
    );
  } else if (state === 'out' || !meta) {
    body = <Login onSignedIn={reloadMeta} />;
  } else if (meta.mustChangePassword) {
    // Signed in with the emailed temporary password: choose their own before anything else.
    body = <ChoosePassword onDone={reloadMeta} onSignOut={signOut} />;
  } else {
    const [top, id, sub] = route;
    // Team members have no Weekly Stand-up or Dashboard: those are for whoever files updates or oversees projects.
    const leads = LEADS_PROJECTS.some((p) => meta.permissions.includes(p));
    let page;
    switch (top) {
      case 'projects':
        page = id ? <ProjectPage key={id} id={Number(id)} tab={sub ?? 'plan'} /> : <Portfolio />;
        break;
      case 'updates':
        page = leads ? <WeeklyReview meeting={id === 'meeting'} /> : <Portfolio />;
        break;
      case 'report':
        page = meta.permissions.includes('report.view') ? <Report /> : <Portfolio />;
        break;
      case 'my-work':
        page = <MyWork />;
        break;
      case 'assignments':
        page = <Assignments />;
        break;
      case 'insights':
        page = meta.permissions.includes('projects.edit_all') ? <Insights /> : <Portfolio />;
        break;
      case 'org':
        // The org chart lives under Users & permissions now; old links land there.
        navigate(meta.canManageUsers ? '/people/org' : '/portfolio');
        page = <Portfolio />;
        break;
      case 'people':
        page = meta.canManageUsers ? <People tab={id ?? 'users'} /> : <Portfolio />;
        break;
      case 'dashboard':
        page = leads ? <Dashboard /> : <Portfolio />;
        break;
      case 'milestones':
        page = leads ? <Milestones /> : <MyWork />;
        break;
      default:
        page = <Portfolio path={route} />;
        if (top && top !== 'portfolio') navigate('/portfolio');
    }
    body = (
      <AppProvider meta={meta} reloadMeta={reloadMeta}>
        <Shell route={route} theme={theme} onTheme={toggleTheme} onSignOut={signOut}>
          {/* A page arrives as a whole; tabs inside a project animate on their own. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${top ?? ''}/${top === 'projects' ? id ?? '' : ''}`}
              // Opacity only: a transform here would trap the fixed dialogs,
              // drawers and meeting mode inside this box. Pages rise via .enter.
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
            >
              <Suspense fallback={<PageSkeleton />}>{page}</Suspense>
            </motion.div>
          </AnimatePresence>
        </Shell>
      </AppProvider>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <LangContext.Provider value={langValue}>
        <ToastProvider>
          {body}
          <UnsavedPrompt />
        </ToastProvider>
      </LangContext.Provider>
    </MotionConfig>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

installTableSort();
installFreshVersion();
