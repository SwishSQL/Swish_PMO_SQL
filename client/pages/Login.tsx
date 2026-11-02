import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react';
import {
  ArrowFatUp,
  ArrowRight,
  CalendarBlank,
  Check,
  EnvelopeSimple,
  Eye,
  EyeSlash,
  LockKey,
  ShieldCheck,
  Sparkle,
  UsersThree,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { api, ApiError } from '../api';
import { useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { EASE_OUT, spotlight, stagger } from '../lib/motion';
import { BrandMark } from '../components/ui';
import { MIN_PASSWORD } from '../../shared/permissions';


// Five lines across the panel, one per kind of work the PMO runs. Each bends
// once, like a transit line, and carries stations where its milestones sit.
const LINES: { slot: number; y: number; bend: number; rise: number; stations: number[] }[] = [
  { slot: 1, y: 0.16, bend: 0.38, rise: 0.08, stations: [0.12, 0.3, 0.55, 0.78] },
  { slot: 3, y: 0.3, bend: 0.52, rise: -0.06, stations: [0.2, 0.46, 0.7, 0.9] },
  { slot: 2, y: 0.36, bend: 0.3, rise: 0.08, stations: [0.08, 0.36, 0.62] },
  { slot: 7, y: 0.52, bend: 0.6, rise: -0.08, stations: [0.24, 0.5, 0.74, 0.92] },
  { slot: 4, y: 0.56, bend: 0.44, rise: 0.04, stations: [0.16, 0.4, 0.66, 0.86] },
];

function LoginMap() {
  const W = 1000;
  const H = 1000;
  const yAt = (l: (typeof LINES)[number], x: number) => {
    const b = l.bend;
    const start = l.y;
    const end = l.y + l.rise;
    if (x <= b - 0.06) return start;
    if (x >= b + 0.06) return end;
    return start + ((x - (b - 0.06)) / 0.12) * (end - start);
  };
  return (
    <svg className="login-map" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden>
      <style>{`
        .lm-line { stroke-dasharray: 1600; stroke-dashoffset: 1600; animation: lm-draw 1.6s cubic-bezier(.65,0,.35,1) forwards; }
        .lm-stop { opacity: 0; animation: fade-in .4s ease-out forwards; }
        @keyframes lm-draw { to { stroke-dashoffset: 0; } }
        @keyframes fade-in { to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .lm-line { stroke-dashoffset: 0; animation: none; } .lm-stop { opacity: 1; animation: none; } }
      `}</style>
      {LINES.map((l, i) => {
        const pts = [0, l.bend - 0.06, l.bend + 0.06, 1].map((x) => `${x * W},${yAt(l, x) * H}`).join(' ');
        return (
          <g key={i} opacity={0.9}>
            <polyline
              className="lm-line"
              points={pts}
              fill="none"
              stroke={`var(--d${l.slot})`}
              strokeWidth={7}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ animationDelay: `${i * 0.12}s` }}
            />
            {l.stations.map((x, j) => (
              <circle
                key={j}
                className="lm-stop"
                cx={x * W}
                cy={yAt(l, x) * H}
                r={9}
                fill={j < 2 ? `var(--d${l.slot})` : 'currentColor'}
                stroke={j < 2 ? 'currentColor' : `var(--d${l.slot})`}
                strokeWidth={j < 2 ? 3 : 5}
                style={{ animationDelay: `${0.9 + i * 0.12 + j * 0.08}s`, color: 'var(--login-bg, #14181d)' }}
              />
            ))}
          </g>
        );
      })}
      <line x1={0.58 * W} x2={0.58 * W} y1={0.06 * H} y2={0.66 * H} stroke="currentColor" strokeOpacity={0.35} strokeWidth={2} strokeDasharray="4 8" />
    </svg>
  );
}

const DOMAIN = '@swishhh.net';

/** 0-4: length, mixed case, digits, symbols. Shown only when choosing a password. */
function strength(pw: string): number {
  if (pw.length < MIN_PASSWORD) return 0;
  let s = 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 14) s++;
  return Math.min(4, s);
}

type Phase = 'idle' | 'busy' | 'done';

/**
 * Sign in, or, opened from a setup link (#/activate/<token>), set up the
 * account: the email comes from the link and the password is typed twice.
 */
export function Login({ onSignedIn, invite, onLeaveInvite }: { onSignedIn: () => void; invite?: string; onLeaveInvite?: () => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const reduce = useReducedMotion();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const settingUp = !!invite;
  // The link is checked before the form shows: 'checking', the account's name, or the reason it fails.
  const [inviteState, setInviteState] = useState<{ status: 'checking' | 'ok' | 'bad'; name?: string; message?: string }>({ status: 'checking' });
  const [forgot, setForgot] = useState(false);
  // Whether the server can email a first password (mail is set up), and what came of asking for one.
  const [emailSignIn, setEmailSignIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [card, animateCard] = useAnimate();
  const passRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<{ emailSignIn: boolean }>('/api/auth/config')
      .then((c) => setEmailSignIn(c.emailSignIn))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!invite) return;
    let live = true;
    api
      .get<{ email: string; name: string }>(`/api/auth/invite/${encodeURIComponent(invite)}`)
      .then((r) => {
        if (!live) return;
        setEmail(r.email);
        setInviteState({ status: 'ok', name: r.name });
        window.setTimeout(() => passRef.current?.focus(), 50);
      })
      .catch((e) => live && setInviteState({ status: 'bad', message: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [invite]);

  // Type the name, the company domain completes itself.
  const needsDomain = email.length > 0 && !email.includes('@');
  const fullEmail = needsDomain ? email + DOMAIN : email;
  const today = new Date().toLocaleDateString(lang === 'ar' ? 'ar-KW-u-nu-latn' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Kuwait',
  });

  const shake = () => {
    if (reduce || !card.current) return;
    animateCard(card.current, { x: [0, -10, 9, -6, 4, 0] }, { duration: 0.42, ease: 'easeOut' });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (needsDomain) setEmail(fullEmail);
    setPhase('busy');
    setError(null);
    try {
      if (settingUp) {
        if (confirm !== password) throw new Error(t('passwordsDiffer'));
        await api.post('/api/auth/activate', { token: invite, password, confirm });
      } else {
        await api.post('/api/auth/login', { email: fullEmail, password });
      }
      setPhase('done');
      if (settingUp) toast(t('welcomeFirst'));
      // Let the check mark land before the app replaces this screen.
      window.setTimeout(onSignedIn, reduce ? 0 : 520);
    } catch (err) {
      setPhase('idle');
      // A link that died while the form was open (used in another tab, expired).
      if (settingUp && err instanceof ApiError && err.status === 410) {
        setInviteState({ status: 'bad', message: err.message });
        return;
      }
      setError((err as Error).message);
      shake();
    }
  };

  // First time here: the password is emailed to the address typed above, which only its owner can read.
  const emailMe = async () => {
    if (!email) {
      setError(t('emailFirstNeedEmail'));
      shake();
      return;
    }
    setAsking(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/api/auth/first-access', { email: fullEmail });
      if (needsDomain) setEmail(fullEmail);
      setNotice(t('emailSent'));
      window.setTimeout(() => passRef.current?.focus(), 50);
    } catch (err) {
      setError((err as Error).message);
      shake();
    } finally {
      setAsking(false);
    }
  };

  const score = strength(password);
  const strengthLabel = [t('strength0'), t('strength1'), t('strength2'), t('strength3'), t('strength4')][score];
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false);

  return (
    <div className="login">
      <section className="login-art">
        <LoginMap />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10 }}>
          <BrandMark className="brand-mark" onDark />
          <span className="brand-name">SWiSH PMO</span>
        </div>
        <div>
          <h1>{t('signInTitle')}</h1>
          <p>{t('signInBody')}</p>
        </div>
      </section>

      <section className="login-side">
        <div className="login-top li" style={stagger(0)}>
          <span className="login-date">
            <CalendarBlank size={15} aria-hidden />
            {today}
          </span>
        </div>

        {settingUp && inviteState.status === 'bad' ? (
          <div className="login-card spotlight" onPointerMove={spotlight}>
            <div className="li" style={stagger(1)}>
              <div className="login-badge">
                <WarningCircle size={14} weight="fill" aria-hidden />
                {t('firstSignInBadge')}
              </div>
              <h2 className="login-title">{t('inviteInvalidTitle')}</h2>
              <p className="login-sub">{inviteState.message}</p>
            </div>
            <button className="login-btn li" style={stagger(2)} type="button" data-phase="idle" onClick={onLeaveInvite}>
              <span className="login-btn-label">{t('goToSignIn')}</span>
              <ArrowRight size={18} weight="bold" className="login-btn-arrow" aria-hidden />
            </button>
          </div>
        ) : (
        <motion.form ref={card} className="login-card spotlight" onPointerMove={spotlight} onSubmit={submit} noValidate>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={settingUp ? 'setup' : 'signin'}
              className="li"
              style={stagger(1)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: EASE_OUT }}
            >
              <div className="login-badge">
                {settingUp ? <Sparkle size={14} weight="fill" aria-hidden /> : <ShieldCheck size={14} weight="fill" aria-hidden />}
                {settingUp ? t('firstSignInBadge') : t('companyAccount')}
              </div>
              <h2 className="login-title">
                {settingUp ? t('firstSignInTitle', { name: (inviteState.name ?? '').split(' ')[0] }) : t('welcomeBack')}
              </h2>
              <p className="login-sub">{settingUp ? t('firstSignInBody') : t('signInSub')}</p>
            </motion.div>
          </AnimatePresence>

          <label className="ffield li" style={stagger(2)} data-filled={email.length > 0}>
            <EnvelopeSimple size={18} className="ffield-icon" aria-hidden />
            <span className="ffield-ghost" dir="ltr" aria-hidden>
              <span className="ffield-typed">{email}</span>
              {needsDomain && <span>{DOMAIN}</span>}
            </span>
            <input
              type="text"
              inputMode="email"
              dir="ltr"
              autoComplete="username"
              spellCheck={false}
              placeholder=" "
              value={email}
              disabled={settingUp}
              onChange={(e) => setEmail(e.target.value.trim())}
              onKeyDown={(e) => {
                if ((e.key === 'Tab' || e.key === 'ArrowRight') && needsDomain && !e.shiftKey) {
                  setEmail(fullEmail);
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    passRef.current?.focus();
                  }
                }
              }}
              required
            />
            <span className="ffield-label">{t('email')}</span>
            {needsDomain && (
              <kbd className="ffield-kbd" aria-hidden>
                Tab
              </kbd>
            )}
            <i className="ffield-glow" aria-hidden />
          </label>

          <label className="ffield li" style={stagger(3)} data-filled={password.length > 0}>
            <LockKey size={18} className="ffield-icon" aria-hidden />
            <input
              ref={passRef}
              type={show ? 'text' : 'password'}
              autoComplete={settingUp ? 'new-password' : 'current-password'}
              placeholder=" "
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyUp={onKey}
              onKeyDown={onKey}
              required
            />
            <span className="ffield-label">{settingUp ? t('newPassword') : t('password')}</span>
            <button
              type="button"
              className="ffield-eye"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? t('hidePassword') : t('showPassword')}
              title={show ? t('hidePassword') : t('showPassword')}
            >
              {show ? <EyeSlash size={18} /> : <Eye size={18} />}
            </button>
            <i className="ffield-glow" aria-hidden />
          </label>

          <AnimatePresence initial={false}>
            {settingUp && (
              <motion.div
                key="setup"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.35, ease: EASE_OUT }}
                style={{ overflow: 'hidden' }}
              >
                <div className="pw-strength" data-score={score} aria-live="polite">
                  <div className="pw-bars" aria-hidden>
                    {[1, 2, 3, 4].map((n) => (
                      <i key={n} data-on={score >= n} />
                    ))}
                  </div>
                  <span>{strengthLabel}</span>
                </div>
                <label className="ffield" data-filled={confirm.length > 0} style={{ marginTop: 14 }}>
                  <LockKey size={18} className="ffield-icon" aria-hidden />
                  <input
                    type={show ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder=" "
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                  <span className="ffield-label">{t('confirmPassword')}</span>
                  {confirm.length > 0 && (
                    <span className={`ffield-match ${confirm === password ? 'ok' : ''}`} aria-hidden>
                      {confirm === password ? <Check size={16} weight="bold" /> : <X size={16} weight="bold" />}
                    </span>
                  )}
                  <i className="ffield-glow" aria-hidden />
                </label>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {caps && (
              <motion.div className="login-note" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <ArrowFatUp size={14} weight="fill" aria-hidden />
                {t('capsLock')}
              </motion.div>
            )}
            {notice && !error && (
              <motion.div key="notice" className="login-note" role="status" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <EnvelopeSimple size={14} weight="fill" aria-hidden />
                {notice}
              </motion.div>
            )}
            {error && (
              <motion.div
                key={error}
                className="login-error"
                role="alert"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <WarningCircle size={16} weight="fill" aria-hidden />
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          <button
            className="login-btn li"
            style={stagger(4)}
            type="submit"
            data-phase={phase}
            disabled={phase !== 'idle' || !email || !password || (settingUp && (inviteState.status !== 'ok' || !confirm))}
          >
            <span className="login-btn-label">{settingUp ? t('setPasswordAndSignIn') : t('signIn')}</span>
            <span className="login-btn-route" aria-hidden>
              <i />
              <b />
              <b />
              <b />
            </span>
            <span className="login-btn-done" aria-hidden>
              <Check size={20} weight="bold" />
            </span>
            <ArrowRight size={18} weight="bold" className="login-btn-arrow" aria-hidden />
          </button>

          {!settingUp && emailSignIn && (
            <div className="login-forgot">
              <button type="button" className="btn btn-sm" disabled={asking || phase !== 'idle'} onClick={emailMe}>
                <EnvelopeSimple size={15} aria-hidden />
                {asking ? t('emailSending') : t('emailFirst')}
              </button>
            </div>
          )}

          {!settingUp && (
            <div className="login-forgot">
              <button type="button" className="btn btn-ghost btn-sm" aria-expanded={forgot} onClick={() => setForgot((f) => !f)}>
                {t('forgotPassword')}
              </button>
              <AnimatePresence initial={false}>
                {forgot && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease: EASE_OUT }}
                  >
                    {emailSignIn ? t('forgotHintEmail') : t('forgotHint')}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          )}
        </motion.form>
        )}

        <p className="login-foot li" style={stagger(5)}>
          <UsersThree size={16} aria-hidden />
          {t('askForAccount')}
        </p>
      </section>
    </div>
  );
}
