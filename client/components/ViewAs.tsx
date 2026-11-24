import { useMemo, useState } from 'react';
import { Eye, MagnifyingGlass, SignOut } from '@phosphor-icons/react';
import { api } from '../api';
import { useApp, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { forgetUnsaved } from '../lib/unsaved';
import { Avatar, Dialog } from './ui';

// View as: a PMO admin opens the app as a real person sees it (their home page, projects, milestones, what opens
// and what is locked) to test their journey. Everything can be clicked and tried; the server saves nothing.

const reloadHome = () => {
  // Switching who you are is the point: no browser "Reload site?" question for a search typed in the picker.
  forgetUnsaved();
  window.location.hash = '#/portfolio';
  window.location.reload();
};

export function ViewAsDialog({ onClose }: { onClose: () => void }) {
  const { meta, roleName } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  // People grouped by role, the roles that see the least first.
  const order = ['member', 'pm', 'dept_head', 'executive'];
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const people = meta.users.filter((u) => u.active && u.id !== meta.me.id && (!needle || `${u.name} ${u.email}`.toLowerCase().includes(needle)));
    const byRole = new Map<string, typeof people>();
    for (const u of people) byRole.set(u.roleId, [...(byRole.get(u.roleId) ?? []), u]);
    return [...byRole.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, meta.users]);
  const pick = async (userId: number) => {
    setBusy(true);
    try {
      await api.post('/api/view-as', { userId });
      reloadHome();
    } catch (e) {
      toast((e as Error).message, 'bad');
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('va_title')} onClose={onClose} width={560}>
      <p style={{ marginTop: 0 }} className="muted">
        {t('va_intro')}
      </p>
      <div className="search" style={{ marginBottom: 12 }}>
        <MagnifyingGlass size={16} aria-hidden />
        <input className="input" type="search" placeholder={t('va_search')} aria-label={t('va_search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="va-list">
        {groups.map(([roleId, people]) => (
          <section key={roleId}>
            <h3 className="va-group">
              {roleName(roleId, lang)} <span className="num">{people.length}</span>
            </h3>
            {people.map((u) => (
              <button key={u.id} className="va-person" disabled={busy} onClick={() => pick(u.id)}>
                <Avatar user={u} />
                <span>
                  <strong>{u.name}</strong>
                  <small>{u.title || u.email}</small>
                </span>
                <Eye size={16} aria-hidden />
              </button>
            ))}
          </section>
        ))}
        {groups.length === 0 && <p className="muted">{t('va_none')}</p>}
      </div>
    </Dialog>
  );
}

/** The bar on every page while viewing as someone: who, that nothing is saved, and the way out. */
export function ViewAsBanner() {
  const { meta, roleName } = useApp();
  const { t, lang } = useT();
  if (!meta.viewingAs) return null;
  const exit = async () => {
    await api.post('/api/view-as/exit').catch(() => undefined);
    reloadHome();
  };
  return (
    <div className="va-banner" role="status">
      <Eye size={18} weight="fill" aria-hidden />
      <span>
        {t('va_banner', { name: meta.me.name, role: roleName(meta.me.roleId, lang) })}
      </span>
      <button className="btn btn-sm" onClick={exit}>
        <SignOut size={14} aria-hidden /> {t('va_exit')}
      </button>
    </div>
  );
}
