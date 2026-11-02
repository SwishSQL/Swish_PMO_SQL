import { useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as RPointerEvent } from 'react';
import { animate, useReducedMotion } from 'motion/react';

// One easing family for the whole product: quick to start, soft to land.
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;

/** A number that counts up to its value the first time it is shown, then glides between values. */
export function CountUp({ value, duration = 1.1, className }: { value: number; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      el.textContent = String(value);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration,
      ease: EASE_OUT,
      onUpdate: (v) => {
        el.textContent = String(Math.round(v));
      },
    });
    from.current = value;
    return () => controls.stop();
  }, [value, duration, reduce]);
  return (
    <span ref={ref} className={className}>
      {reduce ? value : 0}
    </span>
  );
}

/** Index for CSS stagger: style={stagger(i)} pairs with the .enter class. */
export function stagger(i: number, extra?: CSSProperties): CSSProperties {
  return { ['--i' as string]: Math.min(i, 24), ...extra };
}

/** Pointer-tracked light for .spotlight surfaces. */
export function spotlight(e: RPointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
}
