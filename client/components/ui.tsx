import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { AppContext, useToast } from '../lib/app';
import { download } from '../api';
import { SPRING } from '../lib/motion';
import {
  CheckCircle,
  CircleDashed,
  SealCheck,
  WarningCircle,
  XCircle,
  X,
} from '@phosphor-icons/react';
import type { Health, User } from '../../shared/types';
import { useT } from '../lib/i18n';
import { confirmLeave, useUnsaved } from '../lib/unsaved';
import { initials } from '../lib/format';

export const deptColor = (slot: number | undefined) => `var(--d${((slot ?? 1) - 1) % 8 + 1})`;

/** Downloads a file the server builds. A failure is a message, never a browser error page. */
export function ExportButton({
  url,
  body,
  className = 'btn',
  title,
  disabled,
  children,
}: {
  url: string;
  body?: unknown;
  className?: string;
  title?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      title={title}
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          await download(url, body);
        } catch (e) {
          toast((e as Error).message, 'bad');
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

/** A ref that always holds the latest value, for callbacks an effect should not re-run on. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function HealthIcon({ health, size = 16, x, y }: { health: Health; size?: number; x?: number; y?: number }) {
  const props = { size, weight: 'fill' as const, 'aria-hidden': true, x, y };
  switch (health) {
    case 'on_track':
      return <CheckCircle {...props} />;
    case 'at_risk':
      return <WarningCircle {...props} />;
    case 'off_track':
      return <XCircle {...props} />;
    case 'done':
      return <SealCheck {...props} />;
    default:
      return <CircleDashed size={size} weight="bold" aria-hidden x={x} y={y} />;
  }
}

export function HealthBadge({ health, pill = false }: { health: Health; pill?: boolean }) {
  const { t } = useT();
  return (
    <span className={`${pill ? 'pill' : 'health'} h-${health}`}>
      <HealthIcon health={health} size={pill ? 14 : 16} />
      {t(`health_${health}`)}
    </span>
  );
}

export function Avatar({ user, size }: { user?: User; size?: 'sm' | 'lg' }) {
  // Tinted with the person's department line, so a team reads as a set of colours.
  const app = useContext(AppContext);
  if (!user) return <span className={`avatar ${size ? `avatar-${size}` : ''}`}>-</span>;
  const slot = app?.dept(user.departmentId)?.colorSlot;
  return (
    <span
      className={`avatar ${size ? `avatar-${size}` : ''}`}
      title={user.name}
      aria-hidden
      style={slot ? ({ '--tone': deptColor(slot) } as React.CSSProperties) : undefined}
    >
      {initials(user.name)}
    </span>
  );
}

/** A person with an account, or just a name as written in the tracker. */
export function Person({ user, name, size = 'sm' }: { user?: User; name?: string | null; size?: 'sm' | 'lg' }) {
  const { t } = useT();
  const label = user?.name ?? name ?? null;
  return (
    <span className="person">
      {user ? <Avatar user={user} size={size} /> : <NameAvatar name={label} size={size} />}
      <span className={label ? '' : 'muted'}>{label ?? t('unassigned')}</span>
    </span>
  );
}

export function NameAvatar({ name, size }: { name: string | null; size?: 'sm' | 'lg' }) {
  return (
    <span className={`avatar ${size ? `avatar-${size}` : ''}`} title={name ?? undefined} aria-hidden>
      {name ? initials(name) : '-'}
    </span>
  );
}

export function Meter({ value, expected }: { value: number; expected?: number }) {
  return (
    <div className="meter" role="img" aria-label={`${value}%`}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      {expected !== undefined && <b style={{ insetInlineStart: `calc(${expected}% - 1px)` }} />}
    </div>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass an inline onClose, a new function on every render. Keeping it
  // in a ref lets the focus effect run once on open: re-running it on each
  // keystroke threw focus back to the first field.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const typed = () => setDirty(true);
    const saved = () => setDirty(false);
    el?.addEventListener('input', typed);
    window.addEventListener('pmo:saved', saved);
    return () => {
      el?.removeEventListener('input', typed);
      window.removeEventListener('pmo:saved', saved);
    };
  }, []);
  const guard = useUnsaved(dirty, typeof title === 'string' ? title : t('thisForm'));
  const closeRef = useLatest(async () => {
    if (await confirmLeave(guard)) onClose();
  });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(.dialog-x)');
    first?.focus();
    // Esc closes the popup on top only.
    const onKey = (e: KeyboardEvent) => {
      // A guided tour open on top takes Esc for itself.
      if (e.key !== 'Escape' || document.querySelector('.tour')) return;
      const all = document.querySelectorAll('.dialog');
      if (all[all.length - 1] === ref.current) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [closeRef]);
  // At the top of the page, like the drawer, so where it is opened from never decides what covers it.
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div className="dialog" role="dialog" aria-modal="true" ref={ref} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <button className="btn btn-ghost btn-icon btn-sm dialog-x" onClick={() => closeRef.current()} aria-label={t('close')}>
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  const closeRef = useLatest(onClose);
  useEffect(() => {
    // A popup open over the drawer takes Esc for itself.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.scrim, .tour') && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeRef]);
  // Drawn at the top of the page, not where it is opened: a drawer opened from the sidebar would
  // otherwise share the sidebar's layer and sit under the page.
  return createPortal(
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </aside>
    </>,
    document.body,
  );
}

export function Field({
  label,
  children,
  hint,
  warn,
  className,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  /** A caution about the value (shown in place of the hint), such as a date on a day off. */
  warn?: string | null;
  className?: string;
}) {
  return (
    <label className={`field ${className ?? ''}`}>
      <span>{label}</span>
      {children}
      {warn ? (
        <em className="hint hint-warn" role="status">
          {warn}
        </em>
      ) : (
        hint && <em className="hint">{hint}</em>
      )}
    </label>
  );
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: V;
  options: { value: V; label: ReactNode }[];
  onChange: (v: V) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-thumb" transition={SPRING} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div className="panel">
      <Empty
        title={t('errorTitle')}
        body={message}
        action={
          onRetry && (
            <button className="btn" onClick={onRetry}>
              {t('retry')}
            </button>
          )
        }
      />
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, maxWidth: "100%", ...style }} aria-hidden />;
}

export function PageSkeleton() {
  const { t } = useT();
  return (
    <div aria-busy="true" aria-label={t('loading')}>
      <Skeleton h={30} w={280} />
      <Skeleton h={16} w={420} style={{ marginTop: 12 }} />
      <Skeleton h={120} style={{ marginTop: 28, borderRadius: 14 }} />
      <Skeleton h={420} style={{ marginTop: 20, borderRadius: 14 }} />
    </div>
  );
}

/** Small floating tooltip that follows a pointer position. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const node = tip ? (
    <div
      className="tooltip"
      role="tooltip"
      style={{
        left: Math.min(tip.x + 14, window.innerWidth - 296),
        top: tip.y + 16 > window.innerHeight - 120 ? tip.y - 96 : tip.y + 16,
      }}
    >
      {tip.content}
    </div>
  ) : null;
  return {
    node,
    show: (e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content }),
    hide: () => setTip(null),
  };
}

/** The mark: a short line with three stations, the PMO's own metaphor. */
export function BrandMark({ className, onDark = false }: { className?: string; onDark?: boolean }) {
  // On the dark rail the tile turns light so the mark keeps its shape.
  const tile = onDark ? '#f2f4f7' : 'var(--ink)';
  const ink = onDark ? '#0f1318' : 'var(--surface)';
  return (
    <svg className={className} viewBox="0 0 28 28" aria-hidden>
      <rect width="28" height="28" rx="8" fill={tile} />
      <path d="M6 18 L12 18 L16 10 L22 10" fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6" cy="18" r="2.6" fill={ink} />
      <circle cx="14" cy="14" r="2.6" fill={tile} stroke={ink} strokeWidth="2" />
      <circle cx="22" cy="10" r="2.6" fill={ink} />
    </svg>
  );
}
