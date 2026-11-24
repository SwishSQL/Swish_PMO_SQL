import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WarningCircle } from '@phosphor-icons/react';
import { useT } from './i18n';

// Nothing typed is lost without asking. A form with changes not yet saved registers here while it has them;
// closing it, opening something else, moving to another page or leaving the site asks first:
// save now, discard, or keep editing.

interface Guard {
  label: string;
  /** Saves the changes; false (or a throw) when they could not be saved. */
  save?: () => Promise<boolean | void>;
  discard?: () => void;
}

const guards = new Map<string, Guard>();
type Answer = 'save' | 'discard' | 'stay';
let show: ((g: { label: string; canSave: boolean }) => Promise<Answer>) | null = null;

export const hasUnsaved = () => guards.size > 0;
/** Forget every unsaved form: the page is about to reload on purpose as someone else (View as), so drafts do not apply. */
export const forgetUnsaved = () => guards.clear();

/** Registers a form's unsaved changes while `dirty` is true. Returns the guard's id, for confirmLeave(id). */
export function useUnsaved(dirty: boolean, label: string, save?: () => Promise<boolean | void>, discard?: () => void): string {
  const id = useId();
  // Kept current on every render, so the save that runs is the one with what was typed last.
  useEffect(() => {
    if (dirty) guards.set(id, { label, save, discard });
    else guards.delete(id);
  });
  useEffect(() => () => void guards.delete(id), [id]);
  return id;
}

/**
 * Asks before something with unsaved changes goes away: one guard (by id) or every one open. True when it may
 * go: nothing was pending, it was saved, or the person chose to discard it.
 */
export async function confirmLeave(id?: string): Promise<boolean> {
  const ids = id ? (guards.has(id) ? [id] : []) : [...guards.keys()];
  for (const k of ids) {
    const g = guards.get(k);
    if (!g) continue;
    if (!show) return window.confirm(g.label);
    const answer = await show({ label: g.label, canSave: Boolean(g.save) });
    if (answer === 'stay') return false;
    if (answer === 'save') {
      try {
        if ((await g.save!()) === false) return false;
      } catch {
        return false;
      }
    } else {
      g.discard?.();
    }
    guards.delete(k);
  }
  return true;
}

// Closing the tab, refreshing or typing another address: the browser's own "Leave site?" question.
window.addEventListener('beforeunload', (e) => {
  if (!hasUnsaved()) return;
  e.preventDefault();
  e.returnValue = '';
});

/** The question itself, drawn once at the top of the app. */
export function UnsavedPrompt() {
  const { t } = useT();
  const [ask, setAsk] = useState<{ label: string; canSave: boolean; resolve: (a: Answer) => void } | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    show = (g) => new Promise<Answer>((resolve) => setAsk({ ...g, resolve }));
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (!ask) return;
    saveRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc here keeps editing and stops there: the form under it must not close as well.
      e.stopImmediatePropagation();
      answer('stay');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  if (!ask) return null;
  const answer = (a: Answer) => {
    setAsk(null);
    ask.resolve(a);
  };
  return createPortal(
    <div className="scrim unsaved-scrim" onMouseDown={(e) => e.target === e.currentTarget && answer('stay')}>
      <div className="dialog unsaved-dialog" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" style={{ width: 'min(440px, 100%)' }}>
        <div className="dialog-head">
          <h2 className="dialog-title" id="unsaved-title">
            <WarningCircle size={20} weight="fill" aria-hidden style={{ color: 'var(--warn, #c77700)', verticalAlign: '-4px', marginInlineEnd: 6 }} />
            {t('unsavedTitle')}
          </h2>
        </div>
        <div className="dialog-body">
          <p style={{ margin: 0 }}>{t('unsavedBody', { what: ask.label })}</p>
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={() => answer('stay')}>
            {t('unsavedStay')}
          </button>
          <button className="btn btn-danger" onClick={() => answer('discard')}>
            {t('unsavedDiscard')}
          </button>
          {ask.canSave && (
            <button ref={saveRef} className="btn btn-primary" onClick={() => answer('save')}>
              {t('unsavedSave')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
