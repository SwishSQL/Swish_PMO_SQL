import { useRef, useState } from 'react';
import { ArrowsClockwise, CaretDown, CaretRight, WarningCircle } from '@phosphor-icons/react';
import { api } from '../api';
import { useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { Dialog } from './ui';

interface Change {
  code: string;
  name: string;
  from: { status: string; progress: number; comment: string | null; blocker: string | null };
  to: { status: string; progress: number; comment: string | null; blocker: string | null };
}
interface Plan {
  base: string;
  baseFrom: 'file' | 'today';
  rows: number;
  updated: { code: string; name: string; changes: Change[]; unchanged: number }[];
  created: { code: string; name: string; department: string; milestones: number; start: string; end: string; plan: string | null; guessed: { code: string; date: string }[] }[];
  filled: { code: string; name: string; milestones: number; guessed: { code: string; date: string }[] }[];
  extra: { project: string; codes: string[] }[];
  missing: number;
  blankStatus: number;
  duplicates: number;
}

/**
 * The Milestones Tracker: the PMO picks the workbook, sees what it would change (nothing is written yet), and applies
 * it. Dates of existing projects are never touched.
 */
export function TrackerUpdateButton({ onDone }: { onDone: () => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const pick = async (f: File) => {
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(new Error(t('deliveryReadFailed')));
        r.readAsDataURL(f);
      });
      setPlan(await api.post<Plan>('/api/tracker/preview', { data }));
      setFile({ name: f.name, data });
      setOpen(new Set());
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setPlan(null);
    setFile(null);
  };
  const apply = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const done = await api.post<Plan>('/api/tracker/apply', file);
      toast(t('trkDone', { u: done.updated.reduce((n, p) => n + p.changes.length, 0), c: done.created.length }));
      close();
      onDone();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const toggle = (k: string) => setOpen((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const nothing = plan && plan.updated.length === 0 && plan.created.length === 0 && plan.filled.length === 0;
  const status = (s: string) => t(`status_${s}` as TKey);

  return (
    <>
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => input.current?.click()} title={t('trkHint')}>
        <ArrowsClockwise size={15} aria-hidden /> {t('trkButton')}
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) pick(f);
        }}
      />
      {plan && (
        <Dialog
          title={t('trkTitle')}
          onClose={close}
          width={860}
          footer={
            <>
              <button className="btn" onClick={close}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={busy || !!nothing} onClick={apply}>
                {t('trkApply')}
              </button>
            </>
          }
        >
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            {t('trkFile', { f: file?.name ?? '', n: plan.rows, d: fmtDate(plan.base, lang, true) })}
            {plan.baseFrom === 'today' && (
              <>
                {' '}
                <WarningCircle size={14} aria-hidden /> {t('trkBaseGuess')}
              </>
            )}
          </p>
          {nothing && <p>{t('trkNothing')}</p>}

          {plan.created.length > 0 && (
            <section className="trk-block">
              <h3 className="cr-section">{t('trkCreated', { n: plan.created.length })}</h3>
              <ul className="trk-list">
                {plan.created.map((c) => (
                  <li key={c.code}>
                    <strong>
                      {c.code} · {c.name}
                    </strong>
                    <span className="muted">
                      {t('trkCreatedLine', { m: c.milestones, d: c.department, s: fmtDate(c.start, lang), e: fmtDate(c.end, lang) })}
                      {c.plan ? ` · ${c.plan}` : ` · ${t('trkNoPlan')}`}
                    </span>
                    {c.guessed.length > 0 && (
                      <span className="trk-warn">
                        <WarningCircle size={14} aria-hidden /> {t('trkGuessed', { l: c.guessed.slice(0, 4).map((g) => `${g.code} ${fmtDate(g.date, lang)}`).join(', ') + (c.guessed.length > 4 ? ` +${c.guessed.length - 4}` : '') })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.updated.length > 0 && (
            <section className="trk-block">
              <h3 className="cr-section">{t('trkUpdated', { n: plan.updated.reduce((s, p) => s + p.changes.length, 0), p: plan.updated.length })}</h3>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>{t('trkUpdatedHint')}</p>
              <ul className="trk-list">
                {plan.updated.map((u) => (
                  <li key={u.code}>
                    <button className="trk-toggle" onClick={() => toggle(u.code)} aria-expanded={open.has(u.code)}>
                      {open.has(u.code) ? <CaretDown size={13} aria-hidden /> : <CaretRight size={13} aria-hidden style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} />}
                      <strong>
                        {u.code} · {u.name}
                      </strong>
                      <span className="muted">{t('trkChanged', { n: u.changes.length, u: u.unchanged })}</span>
                    </button>
                    {open.has(u.code) && (
                      <table className="table trk-table">
                        <tbody>
                          {u.changes.map((c) => (
                            <tr key={c.code}>
                              <td className="code">{c.code}</td>
                              <td dir="auto">{c.name}</td>
                              <td className="muted num">
                                {status(c.from.status)} {c.from.progress}%
                              </td>
                              <td className="num">
                                <strong>
                                  {status(c.to.status)} {c.to.progress}%
                                </strong>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.filled.length > 0 && (
            <section className="trk-block">
              <h3 className="cr-section">{t('trkFilled', { n: plan.filled.length })}</h3>
              <ul className="trk-list">
                {plan.filled.map((c) => (
                  <li key={c.code}>
                    <strong>
                      {c.code} · {c.name}
                    </strong>
                    <span className="muted">{t('trkFilledLine', { m: c.milestones })}</span>
                    {c.guessed.length > 0 && (
                      <span className="trk-warn">
                        <WarningCircle size={14} aria-hidden /> {t('trkGuessed', { l: c.guessed.slice(0, 4).map((g) => `${g.code} ${fmtDate(g.date, lang)}`).join(', ') + (c.guessed.length > 4 ? ` +${c.guessed.length - 4}` : '') })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="muted" style={{ fontSize: 12.5 }}>
            {t('trkLeft', { m: plan.missing, b: plan.blankStatus, x: plan.extra.reduce((n, e) => n + e.codes.length, 0), d: plan.duplicates })}
          </p>
        </Dialog>
      )}
    </>
  );
}
