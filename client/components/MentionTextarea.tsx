import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent, TextareaHTMLAttributes } from 'react';
import { useApp } from '../lib/app';
import { mentionsIn } from './MentionText';
import { useT } from '../lib/i18n';

// A text box where "@" names someone: a list of people opens under it, picking one writes "@Full Name", and when the
// text is saved that person is notified (the server reads the mentions). Otherwise it is a plain textarea.

type Props = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const MentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function MentionTextarea(props, outer) {
  const { meta } = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current as HTMLTextAreaElement);
  const [ask, setAsk] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  const { t } = useT();
  // Who this text will notify, as chips under the box.
  const named = [...new Set(mentionsIn(String(props.value ?? ''), meta.users.filter((u) => u.active).map((u) => u.name)).map((m) => m.name))];

  const people = ask
    ? meta.users
        .filter((u) => u.active && u.id !== meta.me.id && u.name.toLowerCase().includes(ask.query.toLowerCase()))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(ask.query.toLowerCase())) - Number(!b.name.toLowerCase().startsWith(ask.query.toLowerCase())) || a.name.localeCompare(b.name))
        .slice(0, 6)
    : [];

  // What is typed right before the cursor: "@" and up to a few words, on the same line.
  const look = () => {
    const el = ref.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart ?? 0);
    const at = before.lastIndexOf('@');
    if (at < 0 || (at > 0 && /[\w.]/.test(before[at - 1]))) return setAsk(null);
    const query = before.slice(at + 1);
    if (query.includes('\n') || query.length > 40 || query.split(' ').length > 4) return setAsk(null);
    setAsk({ start: at, query });
    setPick(0);
  };

  const choose = (name: string) => {
    const el = ref.current;
    if (!el || !ask) return;
    const caret = el.selectionStart ?? el.value.length;
    const next = `${el.value.slice(0, ask.start)}@${name} ${el.value.slice(caret)}`;
    // Through the native setter, so React's onChange sees it like typing.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const pos = ask.start + name.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
    setAsk(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ask && people.length) {
      if (e.key === 'ArrowDown') return (e.preventDefault(), setPick((p) => (p + 1) % people.length));
      if (e.key === 'ArrowUp') return (e.preventDefault(), setPick((p) => (p - 1 + people.length) % people.length));
      if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), choose(people[pick].name));
      if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), setAsk(null));
    }
    props.onKeyDown?.(e);
  };

  return (
    <div className="mention-box">
      <textarea
        {...props}
        ref={ref}
        onKeyDown={onKeyDown}
        onInput={(e) => (look(), props.onInput?.(e))}
        onKeyUp={(e) => (e.key.startsWith('Arrow') && !ask && look(), props.onKeyUp?.(e))}
        onClick={(e) => (look(), props.onClick?.(e))}
        onBlur={(e) => {
          window.setTimeout(() => setAsk(null), 150);
          props.onBlur?.(e);
        }}
      />
      {named.length > 0 && (
        <div className="mention-chips" aria-live="polite">
          <span>{t('mn_willNotify')}</span>
          {named.map((n) => (
            <mark key={n} className="mention">@{n}</mark>
          ))}
        </div>
      )}
      {ask && people.length > 0 && (
        <ul className="mention-list" role="listbox">
          {people.map((u, i) => (
            <li key={u.id} role="option" aria-selected={i === pick}>
              <button type="button" onMouseDown={(e) => (e.preventDefault(), choose(u.name))}>
                <strong>{u.name}</strong>
                {u.title && <span>{u.title}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
