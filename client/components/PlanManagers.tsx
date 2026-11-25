import { useState } from 'react';
import { Plus, UserCircle } from '@phosphor-icons/react';
import { Dialog, Field } from './ui';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';

// Who leads a portfolio (capability) or a program (dimension): shown to everyone who sees the plan, picked by the PMO.
// They watch: they see the projects underneath and receive escalations at their step of the ladder.

export function PlanManagerCard({ kind, id, userId, onChanged }: { kind: 'capability' | 'dimension'; id: number; userId: number | null; onChanged: () => void }) {
  const { t } = useT();
  const { meta, can } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const label = kind === 'capability' ? t('pp_portfolioManager') : t('pp_programManager');
  const person = meta.users.find((u) => u.id === userId);
  const save = async (v: number | null) => {
    setBusy(true);
    try {
      await api.put('/api/transformation/manager', { kind, id, userId: v });
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="plan-manager">
      <UserCircle size={22} aria-hidden />
      <div>
        <div className="plan-manager-label">{label}</div>
        {can('projects.edit_all') ? (
          <select className="select" disabled={busy} aria-label={label} value={userId ?? ''} onChange={(e) => save(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('pp_notSet')}</option>
            {meta.users
              .filter((u) => u.active)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        ) : (
          <strong>{person?.name ?? t('pp_notSet')}</strong>
        )}
      </div>
    </div>
  );
}

/** The named top steps of the escalation ladder: IBE and CEO (the PMO sets them). */
export function LadderRoles() {
  const { t } = useT();
  const { meta, can } = useApp();
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<Record<string, number | null>>('/api/ladder-roles'), []);
  if (!can('projects.edit_all') || !data) return null;
  const save = async (key: 'ibe' | 'ceo', v: string) => {
    try {
      await api.put('/api/ladder-roles', { [key]: v ? Number(v) : null });
      reload();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const people = meta.users.filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="panel">
      <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
        <strong>{t('lr_title')}</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{t('lr_hint')}</span>
        <div className="form-grid">
          {(['ibe', 'ceo'] as const).map((k) => (
            <label key={k} className="field">
              <span>{t(k === 'ibe' ? 'escRole_ibe' : 'escRole_ceo')}</span>
              <select className="select" value={data[k] ?? ''} onChange={(e) => save(k, e.target.value)}>
                <option value="">{t('pp_notSet')}</option>
                {people.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The PMO adds a program (dimension) to the portfolio on screen: its name and, if known, who leads it. */
export function AddProgramButton({ capabilityId, capabilityName, onAdded }: { capabilityId: number; capabilityName: string; onAdded: () => void }) {
  const { t } = useT();
  const { meta, can } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [manager, setManager] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can('projects.edit_all')) return null;
  const close = () => {
    setOpen(false);
    setName('');
    setManager('');
    setError(null);
  };
  const save = async () => {
    if (!name.trim()) return setError(t('ap_nameNeeded'));
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/transformation/dimensions', { capabilityId, name: name.trim(), managerUserId: manager ? Number(manager) : null });
      toast(t('ap_added', { name: name.trim() }));
      close();
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        <Plus size={14} weight="bold" aria-hidden />
        {t('ap_button')}
      </button>
      {open && (
        <Dialog
          title={t('ap_title', { portfolio: capabilityName })}
          onClose={close}
          width={480}
          footer={
            <>
              {error && (
                <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
                  {error}
                </span>
              )}
              <button className="btn" onClick={close}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={save}>
                {t('ap_button')}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={`${t('ap_name')} *`} className="span-2">
              <input className="input" autoFocus value={name} maxLength={160} dir="auto" onChange={(e) => (setName(e.target.value), setError(null))} />
            </Field>
            <Field label={t('pp_programManager')} hint={t('ap_managerHint')} className="span-2">
              <select className="select" value={manager} onChange={(e) => setManager(e.target.value)}>
                <option value="">{t('pp_notSet')}</option>
                {meta.users
                  .filter((u) => u.active)
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        </Dialog>
      )}
    </>
  );
}
