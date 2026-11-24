import { Fragment, useEffect, useMemo, useState } from 'react';
import { LockSimple } from '@phosphor-icons/react';
import { PERMISSIONS } from '../../shared/permissions';
import type { Permission } from '../../shared/permissions';
import { api } from '../api';
import { useApp, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';

// Every role against every permission in one table: read across to compare roles, tick to change, save once.
// The PMO admin role is protected (it holds everything). Managing accounts is not a role permission: it belongs
// to the system owner and the system admins they appoint.

export function PermissionMatrix() {
  const { meta, reloadMeta } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const initial = useMemo(() => Object.fromEntries(meta.roles.map((r) => [r.id, [...r.permissions]])) as Record<string, Permission[]>, [meta.roles]);
  const [draft, setDraft] = useState<Record<string, Permission[]>>(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(initial), [initial]);
  const changed = meta.roles.filter((r) => !r.protected && JSON.stringify([...(draft[r.id] ?? [])].sort()) !== JSON.stringify([...r.permissions].sort()));
  const toggle = (roleId: string, p: Permission) =>
    setDraft((d) => ({ ...d, [roleId]: d[roleId].includes(p) ? d[roleId].filter((x) => x !== p) : [...d[roleId], p] }));
  const save = async () => {
    setBusy(true);
    try {
      for (const r of changed) await api.patch(`/api/roles/${r.id}`, { name: r.name, nameAr: r.nameAr, permissions: draft[r.id] });
      await reloadMeta();
      toast(t('permissionsSaved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const groups = [...new Set(PERMISSIONS.map((p) => p.group))];
  const users = (roleId: string) => meta.users.filter((u) => u.roleId === roleId && u.active).length;
  return (
    <section className="panel">
      <div className="panel-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13, flex: 1, minWidth: 260 }}>
          {t('pm_intro')}
        </p>
        <div className="toolbar">
          {changed.length > 0 && (
            <button className="btn" disabled={busy} onClick={() => setDraft(initial)}>
              {t('cancel')}
            </button>
          )}
          <button className="btn btn-primary" disabled={busy || changed.length === 0} onClick={save}>
            {changed.length ? t('pm_save', { n: changed.length }) : t('save')}
          </button>
        </div>
      </div>
      <div className="perm-matrix-wrap">
        <table className="perm-matrix">
          <thead>
            <tr>
              <th scope="col">{t('pm_permission')}</th>
              {meta.roles.map((r) => (
                <th key={r.id} scope="col" className={changed.includes(r) ? 'is-changed' : undefined}>
                  <span className="pm-role">
                    {r.protected && <LockSimple size={12} weight="fill" aria-hidden />}
                    {lang === 'ar' && r.nameAr ? r.nameAr : r.name}
                  </span>
                  <span className="pm-users">{t('usersOnRole', { n: users(r.id) })}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                <tr className="pm-group">
                  <th colSpan={meta.roles.length + 1} scope="colgroup">
                    {t(`permGroup_${g}` as TKey)}
                  </th>
                </tr>
                {PERMISSIONS.filter((p) => p.group === g).map((p) => (
                  <tr key={p.key}>
                    <th scope="row">
                      <span className="perm-name">{t(`perm_${p.key}` as TKey)}</span>
                      <span className="perm-desc">{t(`permd_${p.key}` as TKey)}</span>
                    </th>
                    {meta.roles.map((r) => {
                      const on = r.protected || (draft[r.id] ?? []).includes(p.key);
                      const was = r.protected || r.permissions.includes(p.key);
                      return (
                        <td key={r.id} className={on !== was ? 'is-changed' : undefined}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={r.protected || busy}
                            aria-label={`${lang === 'ar' && r.nameAr ? r.nameAr : r.name}: ${t(`perm_${p.key}` as TKey)}`}
                            onChange={() => toggle(r.id, p.key)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
