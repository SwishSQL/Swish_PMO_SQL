import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AddressBook,
  ArrowsMerge,
  Buildings,
  EnvelopeSimple,
  CalendarBlank,
  ClockCounterClockwise,
  CheckCircle,
  Copy,
  Database,
  DownloadSimple,
  WarningCircle,
  Key,
  LinkSimple,
  LockSimple,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  ShieldStar,
  Trash,
  UserPlus,
} from '@phosphor-icons/react';
import type { DirectoryEntry, Permission, ProjectSummary, RoleDef, User } from '../../shared/types';
import { PERMISSIONS, COMPANY_DOMAIN, isCompanyEmail } from '../../shared/permissions';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import type { Key as TKey } from '../lib/i18n';
import { deptName, fmtDateTime } from '../lib/format';
import { SPRING, spotlight, stagger } from '../lib/motion';
import { Avatar, deptColor, Dialog, Field, Segmented } from '../components/ui';
import { ActivityTab, CalendarTab, DepartmentsTab } from './PeopleExtra';

/** makeHead: also make the person the head of their department (replacing the current head, if any). */
type Draft = Partial<User> & { makeHead?: boolean };
/** What the server returns once when it issues a setup link. */
type WithLink = User & { inviteToken: string };
interface IssuedLink {
  name: string;
  token: string;
  expiresAt: string | null;
}
const issued = (u: WithLink): IssuedLink => ({ name: u.name, token: u.inviteToken, expiresAt: u.inviteExpiresAt });

/** Shows a setup link once, to copy and send. Only its hash is kept on the server. */
function InviteLinkDialog({ link, onClose }: { link: IssuedLink; onClose: () => void }) {
  const { t, lang } = useT();
  const { meta } = useApp();
  const toast = useToast();
  const url = `${window.location.origin}${window.location.pathname}#/activate/${link.token}`;
  const ref = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t('linkCopied'));
    } catch {
      // No clipboard access (an http page, or blocked): select it to copy by hand.
      ref.current?.select();
    }
  };
  return (
    <Dialog
      title={t('inviteLinkTitle', { name: link.name })}
      onClose={onClose}
      width={560}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t('close')}
        </button>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        {meta.emailSignIn && (
          <div className="closure-bar" role="status">
            <span className="closure-text">{t('inviteEmailWay', { name: link.name })}</span>
          </div>
        )}
        <div className="invite-link">
          <LinkSimple size={16} aria-hidden style={{ flex: 'none' }} />
          <input ref={ref} className="input" readOnly dir="ltr" value={url} onFocus={(e) => e.target.select()} aria-label={t('inviteLinkTitle', { name: link.name })} />
          <button className="btn" onClick={copy}>
            <Copy size={15} aria-hidden />
            {t('copyLink')}
          </button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          {t('inviteLinkHint', { name: link.name, d: link.expiresAt ? fmtDateTime(link.expiresAt, lang) : '' })}
        </p>
      </div>
    </Dialog>
  );
}

/** Confirms deleting an account for good, after saying what it touches. A person who owns projects or heads a department cannot be deleted yet. */
function DeleteUserDialog({ user, onClose, onDeleted }: { user: User; onClose: () => void; onDeleted: () => void }) {
  const { t } = useT();
  const [fp, setFp] = useState<{ projects: { id: number; code: string; name: string }[]; departments: { id: number; name: string }[]; openTasks: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<NonNullable<typeof fp>>(`/api/users/${user.id}/footprint`).then(setFp).catch((e) => setError((e as Error).message));
  }, [user.id]);
  const blocked = !!fp && (fp.projects.length > 0 || fp.departments.length > 0);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/users/${user.id}`);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('delUserTitle', { name: user.name })}
      onClose={onClose}
      width={520}
      footer={
        <>
          {error && (
            <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary danger-solid" disabled={!fp || blocked || busy} onClick={remove}>
            {t('delUserConfirm')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12, fontSize: 14, lineHeight: 1.6 }}>
        <div>
          <strong>{user.name}</strong> <span className="muted">{user.email}</span>
        </div>
        {blocked && fp ? (
          <div className="closure-bar pending" role="alert">
            <span className="closure-text">
              {t('delUserBlocked')}
              <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
                {fp.projects.map((p) => (
                  <li key={p.id}>
                    <span className="code">{p.code}</span> {p.name}
                  </li>
                ))}
                {fp.departments.map((d) => (
                  <li key={d.id}>{t('delUserHeads', { name: d.name })}</li>
                ))}
              </ul>
            </span>
          </div>
        ) : (
          <>
            <p style={{ margin: 0 }}>{t('delUserBody')}</p>
            {fp && fp.openTasks > 0 && <p style={{ margin: 0 }}>{t('delUserTasks', { n: fp.openTasks })}</p>}
          </>
        )}
        <p className="muted" style={{ margin: 0 }}>
          {t('delUserInstead')}
        </p>
      </div>
    </Dialog>
  );
}

/** Users & permissions: accounts, the directory of names the plans mention, and roles. */
export function People({ tab }: { tab: string }) {
  const { t } = useT();
  const known = ['users', 'directory', 'roles', 'departments', 'calendar', 'activity', 'backup'];
  const current = known.includes(tab) ? tab : 'users';
  const tabs = [
    { key: 'users', href: '#/people', icon: UserPlus, label: t('usersTab') },
    { key: 'directory', href: '#/people/directory', icon: AddressBook, label: t('directoryTab') },
    { key: 'roles', href: '#/people/roles', icon: ShieldCheck, label: t('rolesTab') },
    { key: 'departments', href: '#/people/departments', icon: Buildings, label: t('departmentsTab') },
    { key: 'calendar', href: '#/people/calendar', icon: CalendarBlank, label: t('calendarTab') },
    { key: 'activity', href: '#/people/activity', icon: ClockCounterClockwise, label: t('activityTab') },
    { key: 'backup', href: '#/people/backup', icon: Database, label: t('backupTab') },
  ] as const;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('people')}</h1>
        </div>
      </div>
      <nav className="tabs" aria-label={t('people')}>
        {tabs.map((k) => (
          <a key={k.key} className="tab" href={k.href} aria-current={current === k.key ? 'page' : undefined}>
            {current === k.key && <motion.span layoutId="people-tab" className="tab-ink" transition={SPRING} />}
            <k.icon size={16} aria-hidden />
            {k.label}
          </a>
        ))}
      </nav>
      <div key={current} className="tab-body">
        {current === 'users' ? (
          <UsersTab />
        ) : current === 'directory' ? (
          <DirectoryTab />
        ) : current === 'departments' ? (
          <DepartmentsTab />
        ) : current === 'calendar' ? (
          <CalendarTab />
        ) : current === 'activity' ? (
          <ActivityTab />
        ) : current === 'backup' ? (
          <BackupTab />
        ) : (
          <RolesTab />
        )}
      </div>
    </>
  );
}

// ---- Users ------------------------------------------------------------------

function UsersTab() {
  const { meta, reloadMeta, dept, roleName } = useApp();
  // A role that starts projects only in the departments its holder heads: such a person must be linked as a head.
  const startsInOwnDept = (roleId: string) => {
    const p = meta.roles.find((r) => r.id === roleId)?.permissions ?? [];
    return p.includes('projects.create') && !p.includes('projects.edit_all') && !p.includes('projects.assign');
  };
  const { t, lang } = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [link, setLink] = useState<IssuedLink | null>(null);
  const { data: projects } = useLoad(() => api.get<ProjectSummary[]>('/api/projects'), [], 'projects-all');

  // Projects each person manages: the quickest read of who carries the load.
  const projectCount = new Map<number, number>();
  for (const p of projects ?? []) if (p.managerId) projectCount.set(p.managerId, (projectCount.get(p.managerId) ?? 0) + 1);
  const shown = meta.users
    .filter((u) => roleFilter === 'all' || u.roleId === roleFilter)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    // Saving a department head with a department that has no head makes them its head (the server says so).
    let headOf: string | null = null;
    try {
      if (draft.id) {
        const original = meta.users.find((u) => u.id === draft.id);
        const saved = await api.patch(`/api/users/${draft.id}`, {
          name: draft.name,
          title: draft.title ?? null,
          roleId: draft.roleId,
          departmentId: draft.departmentId ?? null,
          makeHead: draft.makeHead === true,
          // Only the owner sees this switch; send it only when it changed.
          ...(meta.isOwner && original && original.systemAdmin !== draft.systemAdmin ? { systemAdmin: !!draft.systemAdmin } : {}),
        });
        headOf = (saved as { linkedHeadOf?: string | null }).linkedHeadOf ?? null;
      } else {
        const made = await api.post<WithLink & { linkedHeadOf?: string | null }>('/api/users', draft);
        headOf = made.linkedHeadOf ?? null;
        setLink(issued(made));
      }
      await reloadMeta();
      setDraft(null);
      toast(headOf ? t('linkedAsHead', { dept: headOf }) : t('saved'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (u: User) => {
    try {
      await api.patch(`/api/users/${u.id}`, { active: !u.active });
      await reloadMeta();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  // Deleting for good: the dialog first shows what it touches, and refuses while the person owns a project or heads a department.
  const [deleting, setDeleting] = useState<User | null>(null);
  const [mailBusy, setMailBusy] = useState(false);
  // Sends a test email to this admin and shows what the mail server answered.
  const testMail = async () => {
    setMailBusy(true);
    try {
      const r = await api.post<{ sentTo: string }>('/api/mail/test');
      toast(t('mailTestSent', { email: r.sentTo }));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setMailBusy(false);
    }
  };

  const resetPassword = async (u: User) => {
    if (!window.confirm(t('confirmReset', { name: u.name }))) return;
    try {
      setLink(issued(await api.post<WithLink>(`/api/users/${u.id}/reset-password`)));
      await reloadMeta();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  // A lost or expired link: issue another. The old one stops working.
  const newLink = async (u: User) => {
    try {
      setLink(issued(await api.post<WithLink>(`/api/users/${u.id}/invite`)));
      await reloadMeta();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  const emailOk = !!draft?.id || isCompanyEmail(draft?.email ?? '');
  // No link on record (accounts from before setup links) counts as expired.
  const linkDead = (u: User) => !u.inviteExpiresAt || u.inviteExpiresAt < new Date().toISOString();

  return (
    <>
      <div className="filters">
        <Segmented
          label={t('role')}
          value={roleFilter}
          onChange={setRoleFilter}
          options={[
            { value: 'all', label: t('allPeople') },
            ...meta.roles.map((r) => ({ value: r.id, label: lang === 'ar' && r.nameAr ? r.nameAr : r.name })),
          ]}
        />
        {meta.emailSignIn && (
          <button className="btn btn-ghost btn-sm" style={{ marginInlineStart: 'auto' }} disabled={mailBusy} onClick={testMail}>
            <EnvelopeSimple size={15} aria-hidden />
            {t('mailTest')}
          </button>
        )}
        <button
          className="btn btn-primary"
          style={meta.emailSignIn ? undefined : { marginInlineStart: 'auto' }}
          onClick={() => {
            setError(null);
            setDraft({ roleId: 'member', departmentId: meta.departments[0]?.id ?? null });
          }}
        >
          <Plus size={15} weight="bold" aria-hidden />
          {t('addPerson')}
        </button>
      </div>

      <div className="people-grid">
        {shown.map((u, i) => {
          const d = dept(u.departmentId);
          const led = projectCount.get(u.id) ?? 0;
          const isOwnerCard = u.owner;
          return (
            <article key={u.id} className="person-card spotlight enter" data-inactive={!u.active} style={stagger(i)} onPointerMove={spotlight}>
              <Avatar user={u} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {u.name}
                  {isOwnerCard && <LockSimple size={13} weight="fill" className="muted" aria-label={t('ownerAccount')} />}
                </div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {u.title || roleName(u.roleId, lang)}
                </div>
                <div className="code" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.email}
                </div>
                <div className="person-meta">
                  {u.systemAdmin && (
                    <span className="sysadmin-badge" title={t('systemAdminHint')}>
                      <ShieldStar size={13} weight="fill" aria-hidden />
                      {u.owner ? t('ownerAccountShort') : t('systemAdmin')}
                    </span>
                  )}
                  <span className="tag">{roleName(u.roleId, lang)}</span>
                  {d && (
                    <span className="tag">
                      <span className="swatch" style={{ background: deptColor(d.colorSlot) }} />
                      {deptName(d, lang)}
                    </span>
                  )}
                  {led > 0 && <span className="tag num">{t('leads', { n: led })}</span>}
                  {u.active && startsInOwnDept(u.roleId) && !meta.departments.some((x) => x.headUserId === u.id) && (
                    <span className="tag tag-warn" title={t('headNotLinkedHint')}>
                      {t('headNotLinked')}
                    </span>
                  )}
                  {!u.active && <span className="tag">{t('inactive')}</span>}
                  {u.active && u.pending && (
                    <span className="tag" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
                      {t('pendingInvite')}
                    </span>
                  )}
                </div>
                {u.active && u.pending ? (
                  <div style={{ fontSize: 12, marginTop: 8, color: linkDead(u) ? 'var(--bad)' : 'var(--ink-3)' }}>
                    {linkDead(u) ? t('linkExpired') : t('linkValidUntil', { d: fmtDateTime(u.inviteExpiresAt!, lang) })}
                    {!linkDead(u) && u.inviteIssuedBy && meta.users.find((x) => x.id === u.inviteIssuedBy) && (
                      <> · {t('linkMadeBy', { name: meta.users.find((x) => x.id === u.inviteIssuedBy)!.name })}</>
                    )}
                  </div>
                ) : (
                  u.lastLoginAt && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                      {t('lastSeen', { d: fmtDateTime(u.lastLoginAt, lang) })}
                    </div>
                  )
                )}
                {/* System admins cannot change the owner or each other; only the owner can. */}
                {(meta.isOwner || u.id === meta.me.id || (!u.owner && !u.systemAdmin)) && (
                  <div className="person-actions">
                    <button className="btn btn-sm" onClick={() => (setError(null), setDraft({ ...u }))}>
                      {t('edit')}
                    </button>
                    {u.id !== meta.me.id && u.active && !u.pending && (
                      <button className="btn btn-ghost btn-sm btn-icon" title={t('resetPasswordAction')} aria-label={t('resetPasswordAction')} onClick={() => resetPassword(u)}>
                        <Key size={15} />
                      </button>
                    )}
                    {u.active && u.pending && (
                      <button className="btn btn-sm" onClick={() => newLink(u)}>
                        <LinkSimple size={15} aria-hidden />
                        {t('newSetupLink')}
                      </button>
                    )}
                    {u.id !== meta.me.id && !isOwnerCard && (
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(u)}>
                        {u.active ? t('deactivate') : t('reactivate')}
                      </button>
                    )}
                    {u.id !== meta.me.id && !isOwnerCard && (
                      <button className="btn btn-ghost btn-sm btn-icon danger" title={t('delUserAction')} aria-label={t('delUserAction')} onClick={() => setDeleting(u)}>
                        <Trash size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {draft && (
        <Dialog
          title={draft.id ? draft.name : t('addPerson')}
          onClose={() => setDraft(null)}
          footer={
            <>
              {error && (
                <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
                  {error}
                </span>
              )}
              <button className="btn" onClick={() => setDraft(null)}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={busy || !draft.name?.trim() || !emailOk} onClick={save}>
                {t('save')}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={t('companyEmail')} className="span-2">
              <input
                className="input"
                type="email"
                dir="ltr"
                disabled={!!draft.id}
                placeholder={`name${COMPANY_DOMAIN}`}
                value={draft.email ?? ''}
                onChange={(e) => setDraft({ ...draft, email: e.target.value.trim() })}
              />
            </Field>
            <Field label={t('name')}>
              <input className="input" value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t('jobTitle')}>
              <input className="input" value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <Field label={t('role')}>
              <select
                className="select"
                value={draft.systemAdmin || draft.owner ? 'admin' : draft.roleId}
                disabled={!!draft.systemAdmin || !!draft.owner || draft.id === meta.me.id}
                onChange={(e) => setDraft({ ...draft, roleId: e.target.value })}
              >
                {meta.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {lang === 'ar' && r.nameAr ? r.nameAr : r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('department')}>
              <select className="select" value={draft.departmentId ?? ''} onChange={(e) => setDraft({ ...draft, departmentId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">-</option>
                {meta.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deptName(d, lang)}
                  </option>
                ))}
              </select>
            </Field>
            {(() => {
              // A department head starts projects only in the department they head: say whether they will, and
              // let the admin make them the head (replacing the current one) from here.
              const d = meta.departments.find((x) => x.id === draft.departmentId);
              if (!d || draft.systemAdmin || !startsInOwnDept(draft.roleId ?? '')) return null;
              if (draft.id && d.headUserId === draft.id) {
                return <p className="span-2 muted" style={{ margin: 0, fontSize: 13 }}>{t('isHeadOf', { dept: deptName(d, lang) })}</p>;
              }
              const current = d.headUserId ? meta.users.find((u) => u.id === d.headUserId) : null;
              if (!current) return <p className="span-2 muted" style={{ margin: 0, fontSize: 13 }}>{t('willBeHeadOf', { dept: deptName(d, lang) })}</p>;
              return (
                <label className="check-row span-2">
                  <input type="checkbox" checked={!!draft.makeHead} onChange={(e) => setDraft({ ...draft, makeHead: e.target.checked })} />
                  <span>
                    <strong>{t('makeHead', { dept: deptName(d, lang) })}</strong>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {t('makeHeadReplaces', { name: current.name })}
                    </span>
                  </span>
                </label>
              );
            })()}
            {/* Only the owner appoints system admins, and the owner is always one. */}
            {meta.isOwner && !draft.owner && (
              <label className="check-row span-2">
                <input
                  type="checkbox"
                  checked={!!draft.systemAdmin}
                  onChange={(e) => setDraft({ ...draft, systemAdmin: e.target.checked, roleId: e.target.checked ? 'admin' : draft.roleId })}
                />
                <span>
                  <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ShieldStar size={15} weight="fill" aria-hidden />
                    {t('systemAdmin')}
                  </strong>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {t('systemAdminHint')}
                  </span>
                </span>
              </label>
            )}
            {!draft.id && (
              <p className="span-2 pill" style={{ height: 'auto', padding: '10px 12px', whiteSpace: 'normal', borderRadius: 10, margin: 0 }}>
                <Key size={15} aria-hidden style={{ flex: 'none' }} />
                {t('addUserHint')}
              </p>
            )}
          </div>
        </Dialog>
      )}
      {link && <InviteLinkDialog link={link} onClose={() => setLink(null)} />}
      {deleting && (
        <DeleteUserDialog
          user={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            const name = deleting.name;
            setDeleting(null);
            await reloadMeta();
            toast(t('delUserDone', { name }));
          }}
        />
      )}
    </>
  );
}

// ---- Backup -----------------------------------------------------------------
// The company server has its own SQL Server backups. This file is the copy that
// lives somewhere else: if the project or its volume goes, the data does not.

interface LastBackup {
  at: string;
  by: string | null;
  counts: Record<string, number> | null;
}

const BACKUP_STALE_DAYS = 7;

function BackupTab() {
  const { t, lang } = useT();
  const { data: last, reload } = useLoad(() => api.get<LastBackup | null>('/api/backup/last'), []);
  const ageDays = last ? Math.floor((Date.now() - new Date(last.at).getTime()) / 86_400_000) : null;
  const stale = ageDays === null || ageDays >= BACKUP_STALE_DAYS;
  const projects = last?.counts?.projects;
  const milestones = last?.counts?.tasks;

  return (
    <div className="backup-grid">
      <section className="panel backup-hero spotlight enter" onPointerMove={spotlight} style={stagger(0)}>
        <div className="backup-icon" aria-hidden>
          <Database size={26} weight="duotone" />
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 className="panel-title" style={{ margin: 0 }}>{t('backupTitle')}</h2>
          <p className="muted" style={{ margin: '6px 0 14px', maxWidth: 620 }}>
            {t('backupBody')}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            {/* Same-origin download: the session cookie goes with it. */}
            <a className="btn btn-primary" href="/api/backup" download onClick={() => window.setTimeout(reload, 2500)}>
              <DownloadSimple size={16} weight="bold" aria-hidden />
              {t('backupDownload')}
            </a>
            <span className={`backup-last ${stale ? 'stale' : ''}`} role="status">
              {stale ? <WarningCircle size={16} weight="fill" aria-hidden /> : <CheckCircle size={16} weight="fill" aria-hidden />}
              {last
                ? t('backupLast', { d: fmtDateTime(last.at, lang), by: last.by ?? '-' })
                : t('backupNever')}
            </span>
          </div>
          {last && projects !== undefined && (
            <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>
              {t('backupCounts', { p: projects, m: milestones ?? 0 })}
            </p>
          )}
          {stale && (
            <p style={{ fontSize: 13, margin: '10px 0 0', color: 'var(--warn)' }}>{t('backupStale', { n: BACKUP_STALE_DAYS })}</p>
          )}
        </div>
      </section>

      <section className="panel enter" style={stagger(1)}>
        <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
          <h3 className="panel-title" style={{ margin: 0 }}>{t('backupWhatTitle')}</h3>
          <ul className="backup-list">
            <li>{t('backupIn')}</li>
            <li>{t('backupOut')}</li>
            <li>{t('backupKeep')}</li>
          </ul>
        </div>
      </section>

      <section className="panel enter" style={stagger(2)}>
        <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
          <h3 className="panel-title" style={{ margin: 0 }}>{t('backupRailwayTitle')}</h3>
          <ol className="backup-list">
            <li>{t('backupRailway1')}</li>
            <li>{t('backupRailway2')}</li>
            <li>{t('backupRailway3')}</li>
          </ol>
        </div>
      </section>

      <section className="panel enter" style={stagger(3)}>
        <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
          <h3 className="panel-title" style={{ margin: 0 }}>{t('backupRestoreTitle')}</h3>
          <ol className="backup-list">
            <li>{t('backupRestore1')}</li>
            <li>
              {t('backupRestore2')}
              <code className="backup-cmd" dir="ltr">sqlcmd -S SERVER -d DATABASE -U USER -b -i swish-pmo-backup-YYYY-MM-DD.sql</code>
            </li>
            <li>{t('backupRestore3')}</li>
          </ol>
        </div>
      </section>
    </div>
  );
}

// ---- Directory --------------------------------------------------------------
// Every name the plans mention, worked out from the milestones themselves.
// Most have no account: this is where an account is given to the right name,
// and where two spellings of one person become one.

type KindFilter = 'all' | DirectoryEntry['kind'];

function DirectoryTab() {
  const { reloadMeta, user } = useApp();
  const { t } = useT();
  const toast = useToast();
  const { data, setData, error, reload } = useLoad(() => api.get<DirectoryEntry[]>('/api/directory'), []);
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [noAccountOnly, setNoAccountOnly] = useState(false);
  const [giving, setGiving] = useState<DirectoryEntry | null>(null);
  const [link, setLink] = useState<IssuedLink | null>(null);
  const [merging, setMerging] = useState<DirectoryEntry | null>(null);

  if (error) return <div className="panel"><div className="panel-body field-error">{error}</div></div>;
  if (!data) return <div className="skeleton" style={{ height: 420, borderRadius: 14 }} />;

  const counts = {
    all: data.length,
    person: data.filter((d) => d.kind === 'person').length,
    team: data.filter((d) => d.kind === 'team').length,
    external: data.filter((d) => d.kind === 'external').length,
  };
  const q = query.trim().toLowerCase();
  const shown = data.filter(
    (d) => (kind === 'all' || d.kind === kind) && (!noAccountOnly || !d.userId) && (!q || d.name.toLowerCase().includes(q)),
  );
  const linked = data.filter((d) => d.userId).length;

  return (
    <>
      <p className="page-sub" style={{ margin: '0 0 16px' }}>
        {t('directoryIntro', { n: data.length, linked })}
      </p>
      <div className="filters">
        <Segmented
          label={t('directoryTab')}
          value={kind}
          onChange={setKind}
          options={(['all', 'person', 'team', 'external'] as KindFilter[]).map((k) => ({
            value: k,
            label: (
              <>
                {t(`dirKind_${k}`)} <span className="muted num">{counts[k]}</span>
              </>
            ),
          }))}
        />
        <div className="search">
          <MagnifyingGlass size={16} aria-hidden />
          <input className="input" type="search" placeholder={t('searchNames')} aria-label={t('searchNames')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <label className="toggle">
          <input type="checkbox" checked={noAccountOnly} onChange={(e) => setNoAccountOnly(e.target.checked)} />
          {t('noAccountOnly')}
        </label>
      </div>

      <div className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th className="num">{t('projectsOwned')}</th>
              <th className="num">{t('milestonesOwned')}</th>
              <th className="num">{t('coOwners')}</th>
              <th className="num">{t('escalateTo')}</th>
              <th>{t('account')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((d, i) => {
              const u = user(d.userId);
              return (
                <tr key={d.name} className="enter" style={stagger(i)}>
                  <td style={{ minWidth: 220 }}>
                    <div style={{ fontWeight: 500 }}>{d.name}</div>
                    <span className={`dir-kind k-${d.kind}`}>{t(`dirOne_${d.kind}`)}</span>
                  </td>
                  <td className="num">
                    {d.projects || '-'}
                    {d.sponsored > 0 && <div className="code">{t('sponsorOf', { n: d.sponsored })}</div>}
                  </td>
                  <td className="num">
                    {d.milestones ? (
                      <>
                        {d.openMilestones}
                        <span className="muted"> / {d.milestones}</span>
                        {d.overdue > 0 && <div style={{ color: 'var(--bad)', fontSize: 12 }}>{t('overdueN', { n: d.overdue })}</div>}
                      </>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="num">{d.coOwned || '-'}</td>
                  <td className="num">{d.escalations || '-'}</td>
                  <td>
                    {u ? (
                      <span className="pill h-on_track">{u.name}</span>
                    ) : (
                      <span className="muted" style={{ fontSize: 13 }}>{t('noAccount')}</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
                    {!u && d.kind === 'person' && (
                      <button className="btn btn-sm" onClick={() => setGiving(d)}>
                        <UserPlus size={14} aria-hidden />
                        {t('giveAccess')}
                      </button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => setMerging(d)} title={t('mergeInto')}>
                      <ArrowsMerge size={14} aria-hidden />
                      {t('merge')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {giving && (
        <GiveAccessDialog
          entry={giving}
          onClose={() => setGiving(null)}
          onDone={async (created) => {
            setGiving(null);
            setLink(issued(created));
            await reloadMeta();
            reload();
            toast(t('accessGiven', { name: giving.name }));
          }}
        />
      )}
      {link && <InviteLinkDialog link={link} onClose={() => setLink(null)} />}
      {merging && (
        <MergeDialog
          entry={merging}
          all={data}
          onClose={() => setMerging(null)}
          onDone={(next, changed) => {
            setMerging(null);
            setData(next);
            reloadMeta();
            toast(t('mergedN', { n: changed }));
          }}
        />
      )}
    </>
  );
}

function GiveAccessDialog({ entry, onClose, onDone }: { entry: DirectoryEntry; onClose: () => void; onDone: (created: WithLink) => void }) {
  const { meta } = useApp();
  const { t, lang } = useT();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState(entry.projects > 0 ? 'pm' : 'member');
  const [systemAdmin, setSystemAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<WithLink>('/api/users', { email, name: entry.name, roleId, systemAdmin }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('giveAccessTo', { name: entry.name })}
      onClose={onClose}
      width={520}
      footer={
        <>
          {error && (
            <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !isCompanyEmail(email)} onClick={save}>
            {t('giveAccess')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('companyEmail')} className="span-2">
          <input className="input" type="email" dir="ltr" placeholder={`name${COMPANY_DOMAIN}`} value={email} onChange={(e) => setEmail(e.target.value.trim())} />
        </Field>
        <Field label={t('role')} className="span-2">
          <select className="select" value={systemAdmin ? 'admin' : roleId} disabled={systemAdmin} onChange={(e) => setRoleId(e.target.value)}>
            {meta.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {lang === 'ar' && r.nameAr ? r.nameAr : r.name}
              </option>
            ))}
          </select>
        </Field>
        {meta.isOwner && (
          <label className="check-row span-2">
            <input type="checkbox" checked={systemAdmin} onChange={(e) => setSystemAdmin(e.target.checked)} />
            <span>
              <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ShieldStar size={15} weight="fill" aria-hidden />
                {t('systemAdmin')}
              </strong>
              <span className="muted" style={{ fontSize: 13 }}>
                {t('systemAdminHint')}
              </span>
            </span>
          </label>
        )}
        <p className="span-2 pill" style={{ height: 'auto', padding: '10px 12px', whiteSpace: 'normal', borderRadius: 10, margin: 0 }}>
          <Key size={15} aria-hidden style={{ flex: 'none' }} />
          {t('giveAccessHint', { m: entry.milestones, p: entry.projects })}
        </p>
      </div>
    </Dialog>
  );
}

function MergeDialog({
  entry,
  all,
  onClose,
  onDone,
}: {
  entry: DirectoryEntry;
  all: DirectoryEntry[];
  onClose: () => void;
  onDone: (next: DirectoryEntry[], changed: number) => void;
}) {
  const { t } = useT();
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Same kind first, then the rest: a person is most likely a misspelt person.
  const options = [...all]
    .filter((d) => d.name !== entry.name)
    .sort((a, b) => Number(b.kind === entry.kind) - Number(a.kind === entry.kind) || a.name.localeCompare(b.name));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ changed: number; directory: DirectoryEntry[] }>('/api/directory/merge', { from: entry.name, to: target });
      onDone(r.directory, r.changed);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('mergeTitle', { name: entry.name })}
      onClose={onClose}
      width={520}
      footer={
        <>
          {error && (
            <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !target} onClick={save}>
            <ArrowsMerge size={15} aria-hidden />
            {t('merge')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <Field label={t('mergeInto')}>
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">-</option>
            {options.map((o) => (
              <option key={o.name} value={o.name}>
                {o.name} ({t(`dirOne_${o.kind}`)}, {o.milestones})
              </option>
            ))}
          </select>
        </Field>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          {t('mergeExplain', { from: entry.name, to: target || '…' })}
        </p>
      </div>
    </Dialog>
  );
}

// ---- Roles ------------------------------------------------------------------

const GROUPS = ['projects', 'review'] as const;

function RolesTab() {
  const { meta, reloadMeta } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const [selected, setSelected] = useState<string>(meta.roles[1]?.id ?? meta.roles[0]?.id);
  const role = meta.roles.find((r) => r.id === selected) ?? meta.roles[0];
  const [perms, setPerms] = useState<Permission[]>(role?.permissions ?? []);
  const [name, setName] = useState(role?.name ?? '');
  const [nameAr, setNameAr] = useState(role?.nameAr ?? '');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setPerms(role?.permissions ?? []);
    setName(role?.name ?? '');
    setNameAr(role?.nameAr ?? '');
  }, [role?.id, role?.permissions, role?.name, role?.nameAr]);

  if (!role) return null;
  const count = (r: RoleDef) => meta.users.filter((u) => u.roleId === r.id && u.active).length;
  const dirty =
    !role.protected &&
    (JSON.stringify([...perms].sort()) !== JSON.stringify([...role.permissions].sort()) || name !== role.name || nameAr !== role.nameAr);

  const toggle = (p: Permission) => setPerms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const save = async () => {
    try {
      await api.patch(`/api/roles/${role.id}`, { name, nameAr, permissions: perms });
      await reloadMeta();
      toast(t('permissionsSaved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  const remove = async () => {
    if (!window.confirm(t('confirmDeleteRole', { name: role.name }))) return;
    try {
      await api.del(`/api/roles/${role.id}`);
      await reloadMeta();
      setSelected(meta.roles[0].id);
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  return (
    <div className="roles-layout">
      <aside className="roles-list">
        {meta.roles.map((r, i) => (
          <button key={r.id} className="role-item enter" style={stagger(i)} aria-current={r.id === role.id} onClick={() => setSelected(r.id)}>
            {r.id === role.id && <motion.span layoutId="role-pill" className="role-pill" transition={SPRING} />}
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              {r.protected ? <LockSimple size={15} weight="fill" aria-hidden /> : <ShieldCheck size={15} aria-hidden />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lang === 'ar' && r.nameAr ? r.nameAr : r.name}
              </span>
            </span>
            <span className="code">{t('usersOnRole', { n: count(r) })}</span>
          </button>
        ))}
        <button className="btn btn-ghost" style={{ marginTop: 8, justifyContent: 'flex-start' }} onClick={() => setCreating(true)}>
          <Plus size={15} aria-hidden />
          {t('newRole')}
        </button>
      </aside>

      <section className="panel" style={{ minWidth: 0 }}>
        <div className="panel-head" style={{ flexWrap: 'wrap' }}>
          {role.protected ? (
            <div>
              <h2 className="panel-title">{lang === 'ar' && role.nameAr ? role.nameAr : role.name}</h2>
              <div className="muted" style={{ fontSize: 13 }}>
                {t('protectedRole')}
              </div>
            </div>
          ) : (
            <div className="form-grid" style={{ flex: 1, minWidth: 280, maxWidth: 560 }}>
              <Field label={t('roleName')}>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label={t('nameAr')}>
                <input className="input" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
              </Field>
            </div>
          )}
          {!role.protected && (
            <div className="toolbar">
              <button className="btn btn-ghost btn-danger" onClick={remove}>
                <Trash size={15} aria-hidden />
                {t('deleteRole')}
              </button>
              <button className="btn btn-primary" disabled={!dirty} onClick={save}>
                {t('save')}
              </button>
            </div>
          )}
        </div>
        <div className="panel-body perm-groups">
          {GROUPS.map((g) => (
            <div key={g}>
              <h3 className="perm-group-title">{t(`permGroup_${g}` as TKey)}</h3>
              {PERMISSIONS.filter((p) => p.group === g).map((p, i) => {
                const on = role.protected || perms.includes(p.key);
                return (
                  <label key={p.key} className="perm-row enter" style={stagger(i)} data-on={on} data-locked={role.protected}>
                    <span>
                      <span className="perm-name">{t(`perm_${p.key}` as TKey)}</span>
                      <span className="perm-desc">{t(`permd_${p.key}` as TKey)}</span>
                    </span>
                    <span className="switch" aria-hidden>
                      <motion.span className="knob" layout transition={SPRING} />
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      disabled={role.protected}
                      onChange={() => toggle(p.key)}
                    />
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      {creating && <NewRoleDialog onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), setSelected(id))} />}
    </div>
  );
}

function NewRoleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { meta, reloadMeta } = useApp();
  const { t, lang } = useT();
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [copyFrom, setCopyFrom] = useState('member');
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      const base = meta.roles.find((r) => r.id === copyFrom);
      const r = await api.post<RoleDef>('/api/roles', { name, nameAr, permissions: base?.permissions ?? [] });
      await reloadMeta();
      onCreated(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog
      title={t('newRole')}
      onClose={onClose}
      width={480}
      footer={
        <>
          {error && (
            <span className="field-error" role="alert" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={create}>
            {t('add')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('roleName')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('nameAr')}>
          <input className="input" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </Field>
        <Field label={t('copyPermissionsFrom')} className="span-2">
          <select className="select" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            {meta.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {lang === 'ar' && r.nameAr ? r.nameAr : r.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Dialog>
  );
}
