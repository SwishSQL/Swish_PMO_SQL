import type { ReactNode } from 'react';
import { useApp } from '../lib/app';

// Mentions in saved text: "@Full Name" of an account shows highlighted, so it reads as a mention.

/** The accounts named in the text as "@Full Name", longest names first. */
export function mentionsIn(text: string, names: string[]): { name: string; at: number; end: number }[] {
  if (!text.includes('@')) return [];
  const lower = text.toLowerCase();
  const out: { name: string; at: number; end: number }[] = [];
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const key = `@${name.toLowerCase()}`;
    for (let at = lower.indexOf(key); at >= 0; at = lower.indexOf(key, at + key.length)) {
      const end = at + key.length;
      if (!out.some((m) => at < m.end && end > m.at)) out.push({ name, at, end });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function MentionText({ text }: { text: string | null | undefined }) {
  const { meta } = useApp();
  if (!text) return null;
  const found = mentionsIn(text, meta.users.map((u) => u.name));
  if (!found.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let i = 0;
  for (const m of found) {
    if (m.at > i) parts.push(text.slice(i, m.at));
    parts.push(
      <mark key={m.at} className="mention">
        {text.slice(m.at, m.end)}
      </mark>,
    );
    i = m.end;
  }
  if (i < text.length) parts.push(text.slice(i));
  return <>{parts}</>;
}
