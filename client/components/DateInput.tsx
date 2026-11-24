import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { CalendarBlank } from '@phosphor-icons/react';

// Dates are typed and shown day/month/year everywhere, whatever the browser's language. The value stays
// YYYY-MM-DD, and onChange hands it over like an input's change event, so callers keep e.target.value.

const show = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

export function DateInput(p: {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  min?: string;
  max?: string;
  className?: string;
  disabled?: boolean;
  readOnly?: boolean;
  title?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}) {
  const [text, setText] = useState(show(p.value));
  useEffect(() => setText(show(p.value)), [p.value]);
  const picker = useRef<HTMLInputElement>(null);
  const commit = (s: string) => {
    if (!s.trim()) {
      if (p.value) p.onChange({ target: { value: '' } });
      return;
    }
    const m = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{4})$/.exec(s.trim());
    if (m) {
      const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      const d = new Date(`${iso}T00:00:00Z`);
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso) {
        if (iso !== p.value) p.onChange({ target: { value: iso } });
        else setText(show(iso));
        return;
      }
    }
    setText(show(p.value));
  };
  return (
    <span className="date-input" style={p.style}>
      <input
        className={p.className ?? 'input'}
        value={text}
        placeholder="dd/mm/yyyy"
        inputMode="numeric"
        aria-label={p['aria-label']}
        title={p.title}
        disabled={p.disabled}
        readOnly={p.readOnly}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => e.key === 'Enter' && commit(text)}
      />
      {!p.disabled && !p.readOnly && (
        <button
          type="button"
          className="date-input-btn"
          tabIndex={-1}
          aria-hidden
          onClick={() => {
            try {
              picker.current?.showPicker();
            } catch {
              picker.current?.focus();
            }
          }}
        >
          <CalendarBlank size={15} />
        </button>
      )}
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden
        className="date-input-native"
        value={p.value}
        min={p.min}
        max={p.max}
        onChange={(e) => p.onChange({ target: { value: e.target.value } })}
      />
    </span>
  );
}
