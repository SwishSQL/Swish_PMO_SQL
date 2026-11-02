import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Check, LockKey, ShieldCheck, WarningCircle, X } from '@phosphor-icons/react';
import { api } from '../api';
import { useT } from '../lib/i18n';
import { BrandMark } from '../components/ui';
import { MIN_PASSWORD } from '../../shared/permissions';

/**
 * Shown, and nothing else, to someone who signed in with the temporary password from the first-sign-in
 * email: they choose their own before going further. The server enforces it too (it serves nothing else).
 */
export function ChoosePassword({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const { t } = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError(t('passwordsDiffer'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password', { current, next });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, autoComplete: string, extra?: React.ReactNode) => (
    <label className="ffield" data-filled={value.length > 0}>
      <LockKey size={18} className="ffield-icon" aria-hidden />
      <input type="password" autoComplete={autoComplete} placeholder=" " value={value} onChange={(e) => set(e.target.value)} required />
      <span className="ffield-label">{label}</span>
      {extra}
      <i className="ffield-glow" aria-hidden />
    </label>
  );

  return (
    <div className="login">
      <section className="login-art">
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10 }}>
          <BrandMark className="brand-mark" onDark />
          <span className="brand-name">SWiSH PMO</span>
        </div>
        <div>
          <h1>{t('choosePwTitle')}</h1>
          <p>{t('choosePwBody')}</p>
        </div>
      </section>
      <section className="login-side">
        <form className="login-card" onSubmit={submit} noValidate>
          <div>
            <div className="login-badge">
              <ShieldCheck size={14} weight="fill" aria-hidden />
              {t('companyAccount')}
            </div>
            <h2 className="login-title">{t('choosePwTitle')}</h2>
            <p className="login-sub">{t('choosePwBody')}</p>
          </div>
          {field(t('tempPassword'), current, setCurrent, 'current-password')}
          {field(t('newPassword'), next, setNext, 'new-password')}
          {field(
            t('confirmPassword'),
            confirm,
            setConfirm,
            'new-password',
            confirm.length > 0 && (
              <span className={`ffield-match ${confirm === next ? 'ok' : ''}`} aria-hidden>
                {confirm === next ? <Check size={16} weight="bold" /> : <X size={16} weight="bold" />}
              </span>
            ),
          )}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('choosePwRule', { n: MIN_PASSWORD })}
          </p>
          {error && (
            <div className="login-error" role="alert">
              <WarningCircle size={16} weight="fill" aria-hidden />
              {error}
            </div>
          )}
          <button className="login-btn" type="submit" data-phase={busy ? 'busy' : 'idle'} disabled={busy || !current || next.length < MIN_PASSWORD || !confirm}>
            <span className="login-btn-label">{t('choosePwButton')}</span>
            <ArrowRight size={18} weight="bold" className="login-btn-arrow" aria-hidden />
          </button>
          <div className="login-forgot">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
              {t('signOut')}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
