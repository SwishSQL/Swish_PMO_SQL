import { useEffect, useRef, useState } from 'react';
import { ChatCircleText, PaperPlaneRight } from '@phosphor-icons/react';
import { api } from '../api';
import { useT } from '../lib/i18n';
import { Dialog } from './ui';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  projects?: { id: number; code: string; name: string }[];
}

/**
 * Ask a question about the projects you can see ("which Customer Care projects are late, and why?"). The answer
 * comes from the data, only reads, and covers exactly what this person is allowed to see.
 */
export function AskPortfolioDialog({ onClose }: { onClose: () => void }) {
  const { t, lang } = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!busy) return;
    setWaited(0);
    const timer = window.setInterval(() => setWaited((w) => w + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, busy]);

  const send = async (said: string) => {
    const content = said.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content }];
    setTurns(next);
    setText('');
    setBusy(true);
    setError(null);
    try {
      // The last few turns give the follow-up its context ("and in Supply Chain?").
      const messages = next.slice(-7).map((m) => ({ role: m.role, content: m.content }));
      const a = await api.post<{ answer: string; projects: Turn['projects'] }>('/api/ai/ask', { messages });
      setTurns((tt) => [...tt, { role: 'assistant', content: a.answer, projects: a.projects }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const examples = [t('askExample1'), t('askExample2'), t('askExample3')];

  return (
    <Dialog
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <ChatCircleText size={20} weight="fill" aria-hidden /> {t('askTitle')}
        </span>
      }
      onClose={onClose}
      width={760}
      footer={
        <>
          {error && (
            <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('close')}
          </button>
        </>
      }
    >
      <section className="ai-chat" aria-label={t('askTitle')} style={{ minHeight: 360 }}>
        <div className="ai-log" ref={logRef} aria-live="polite">
          {turns.length === 0 && (
            <div className="ai-intro">
              <p>{t('askIntro')}</p>
              <div className="ai-examples">
                {examples.map((x) => (
                  <button key={x} className="chip" onClick={() => send(x)}>
                    {x}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((m, i) => (
            <div key={i} className={`ai-msg ${m.role}`} dir="auto">
              {m.content}
              {m.projects && m.projects.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {m.projects.map((p) => (
                    <a key={p.id} className="chip" href={`#/projects/${p.id}/plan`} onClick={onClose} title={p.name}>
                      {p.code}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="ai-msg assistant ai-busy">
              {t('askThinking')} <span className="num">{waited > 0 ? `${waited}s` : ''}</span>
            </div>
          )}
        </div>
        <form
          className="ai-input"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <textarea
            className="input"
            rows={2}
            value={text}
            dir="auto"
            placeholder={t('askPlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            aria-label={t('askTitle')}
          />
          <button className="btn btn-primary btn-icon" type="submit" disabled={busy || !text.trim()} aria-label={t('aiSend')} title={t('aiSend')}>
            <PaperPlaneRight size={18} weight="fill" style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} />
          </button>
        </form>
      </section>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {t('askNote')}
      </p>
    </Dialog>
  );
}
