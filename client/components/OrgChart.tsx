import { useMemo, useState } from 'react';
import { MagnifyingGlass, PencilSimple, Plus } from '@phosphor-icons/react';
import type { StaffMember } from '../../shared/types';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { Dialog, Empty, ErrorState, Field, PageSkeleton } from './ui';
import { LadderRoles } from './PlanManagers';

// The org chart: each department's people as a reporting tree (head first), with a search across everyone. System
// admins add and correct people here; an account is linked to its person by email.

export function OrgChart({ editable }: { editable: boolean }) {
  const { t, lang } = useT();
  const { meta } = useApp();
  const { data, error, reload } = useLoad(() => api.get<StaffMember[]>('/api/staff'), [], 'staff');
  const [deptId, setDeptId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<StaffMember | 'new' | null>(null);
  const people = useMemo(() => (data ?? []).filter((p) => p.active), [data]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const kids = useMemo(() => {
    const m = new Map<number | null, StaffMember[]>();
    for (const p of people) {
      const k = p.managerId && byId.has(p.managerId) ? p.managerId : null;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    for (const l of m.values()) l.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [people, byId]);
  const below = useMemo(() => {
    const memo = new Map<number, number>();
    const f = (id: number): number => memo.get(id) ?? (memo.set(id, (kids.get(id) ?? []).reduce((n, c) => n + 1 + f(c.id), 0)), memo.get(id)!);
    return f;
  }, [kids]);
  const deptName = (id: number | null) => {
    const d = meta.departments.find((x) => x.id === id);
    return d ? (lang === 'ar' && d.nameAr ? d.nameAr : d.name) : t('unassignedDept');
  };
  const depts = useMemo(() => {
    const ids = [...new Set(people.filter((p) => p.departmentId || !p.boardTitle).map((p) => p.departmentId))];
    return ids.map((id) => ({ id, n: people.filter((p) => p.departmentId === id && (id || !p.boardTitle)).length })).sort((a, b) => deptName(a.id).localeCompare(deptName(b.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, lang]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;
  // The Board of Directors comes first: the owners, above every department.
  const board = people.filter((p) => p.boardTitle).sort((a, b) => (a.boardRank ?? 99) - (b.boardRank ?? 99) || a.name.localeCompare(b.name));
  const current = deptId ?? (board.length ? -1 : (depts[0]?.id ?? null));
  const headUserId = meta.departments.find((d) => d.id === current)?.headUserId ?? null;
  const q = query.trim().toLowerCase();

  const Person = ({ p, depth }: { p: StaffMember; depth: number }) => {
    const [open, setOpen] = useState(depth < 2);
    const ch = kids.get(p.id) ?? [];
    return (
      <li className="org-node">
        <div className="org-row">
          {ch.length ? (
            <button type="button" className="org-toggle" aria-expanded={open} aria-label={p.name} onClick={() => setOpen(!open)}>
              {open ? '−' : '+'}
            </button>
          ) : (
            <span className="org-toggle-space" />
          )}
          <strong>{p.name}</strong>
          {p.userId && p.userId === headUserId && <span className="flag-chip">{t('org_head')}</span>}
          {p.userId && <span className="flag-chip ok">{t('org_hasAccount')}</span>}
          <span className="muted">{p.position}</span>
          {ch.length > 0 && <span className="muted num">· {t('org_below', { n: below(p.id) })}</span>}
          {editable && (
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t('edit')} onClick={() => setEditing(p)}>
              <PencilSimple size={14} />
            </button>
          )}
        </div>
        {open && ch.length > 0 && (
          <ul className="org-list">
            {ch.map((c) => (
              <Person key={c.id} p={c} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  const inDept = people.filter((p) => p.departmentId === current && (current || !p.boardTitle));
  const inSet = new Set(inDept.map((p) => p.id));
  const roots = inDept.filter((p) => !p.managerId || !inSet.has(p.managerId)).sort((a, b) => below(b.id) - below(a.id));
  const hits = q ? people.filter((p) => `${p.name} ${p.position ?? ''} ${p.email ?? ''}`.toLowerCase().includes(q)).slice(0, 60) : [];

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {editable && <LadderRoles />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="search" style={{ flex: '1 1 260px' }}>
          <MagnifyingGlass size={16} aria-hidden />
          <input className="input" type="search" placeholder={t('org_search')} aria-label={t('org_search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="muted">{t('org_count', { n: people.length, d: depts.length })}</span>
        {editable && (
          <button className="btn" onClick={() => setEditing('new')}>
            <Plus size={15} aria-hidden />
            {t('org_add')}
          </button>
        )}
      </div>
      {people.length === 0 ? (
        <Empty title={t('org_empty')} body={t('org_emptyBody')} />
      ) : q ? (
        <section className="panel">
          <ul className="org-list org-root panel-body">
            {hits.map((p) => {
              const chain: string[] = [];
              for (let m = p.managerId ? byId.get(p.managerId) : undefined; m && chain.length < 6; m = m.managerId ? byId.get(m.managerId) : undefined) chain.push(m.name);
              return (
                <li key={p.id} className="org-node">
                  <div className="org-row">
                    <strong>{p.name}</strong>
                    <span className="muted">{p.position}</span>
                    {editable && (
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t('edit')} onClick={() => setEditing(p)}>
                        <PencilSimple size={14} />
                      </button>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 12.5, paddingInlineStart: 4 }}>
                    {deptName(p.departmentId)} · {chain.length ? t('org_reportsTo', { chain: chain.join(' → ') }) : t('org_noManager')}
                  </div>
                </li>
              );
            })}
            {hits.length === 0 && <li className="muted">{t('org_noHits')}</li>}
          </ul>
        </section>
      ) : (
        <div className="org-grid">
          <nav className="panel org-rail" aria-label={t('departmentsTab')}>
            {board.length > 0 && (
              <button type="button" className="org-dept" aria-current={current === -1} onClick={() => setDeptId(-1)}>
                <span>{t('org_board')}</span>
                <span className="muted num">{board.length}</span>
              </button>
            )}
            {depts.map((d) => (
              <button key={d.id ?? 0} type="button" className="org-dept" aria-current={d.id === current} onClick={() => setDeptId(d.id)}>
                <span>{deptName(d.id)}</span>
                <span className="muted num">{d.n}</span>
              </button>
            ))}
          </nav>
          <section className="panel">
            <div className="panel-body">
              {current === -1 ? (
                <>
                  <h3 style={{ margin: '0 0 12px' }}>{t('org_board')}</h3>
                  <div className="board-grid">
                    {board.map((p) => (
                      <div key={p.id} className="board-card">
                        <span className="board-initials" aria-hidden>
                          {p.name
                            .split(/\s+/)
                            .filter(Boolean)
                            .map((w, i, a) => (i === 0 || i === a.length - 1 ? w[0] : ''))
                            .join('')
                            .toUpperCase()}
                        </span>
                        <strong>{p.name}</strong>
                        <span>{p.boardTitle}</span>
                        {p.position && p.position !== p.boardTitle && <span className="board-role">{p.position}</span>}
                        {(kids.get(p.id) ?? []).length > 0 && <span className="muted" style={{ fontSize: 12 }}>{t('org_directReports', { n: (kids.get(p.id) ?? []).length })}</span>}
                        {editable && (
                          <button type="button" className="btn btn-ghost btn-icon btn-sm board-edit" aria-label={t('edit')} onClick={() => setEditing(p)}>
                            <PencilSimple size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <h3 style={{ margin: '0 0 10px' }}>{deptName(current)}</h3>
                  <ul className="org-list org-root">
                    {roots.map((p) => (
                      <Person key={p.id} p={p} depth={0} />
                    ))}
                  </ul>
                </>
              )}
            </div>
          </section>
        </div>
      )}
      {editing && <StaffDialog person={editing === 'new' ? null : editing} people={people} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), reload())} />}
    </div>
  );
}

function StaffDialog({ person, people, onClose, onSaved }: { person: StaffMember | null; people: StaffMember[]; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useT();
  const { meta } = useApp();
  const toast = useToast();
  const [name, setName] = useState(person?.name ?? '');
  const [email, setEmail] = useState(person?.email ?? '');
  const [position, setPosition] = useState(person?.position ?? '');
  const [dept, setDept] = useState<number | ''>(person?.departmentId ?? '');
  const [manager, setManager] = useState<number | ''>(person?.managerId ?? '');
  const [active, setActive] = useState(person?.active ?? true);
  const [boardTitle, setBoardTitle] = useState(person?.boardTitle ?? '');
  const [boardRank, setBoardRank] = useState<string>(person?.boardRank != null ? String(person.boardRank) : '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim(), email: email.trim() || null, position: position.trim() || null, departmentId: dept || null, managerId: manager || null, active, boardTitle: boardTitle.trim() || null, boardRank: boardRank ? Number(boardRank) : null };
      if (person) await api.patch(`/api/staff/${person.id}`, body);
      else await api.post('/api/staff', body);
      toast(t('saved'));
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  // Anyone can be the manager: the same department first, then the owners and executives (no department), then the rest.
  const others = people.filter((p) => p.id !== person?.id).sort((a, b) => a.name.localeCompare(b.name));
  const groups = [
    { label: t('org_sameDept'), list: others.filter((p) => dept && p.departmentId === dept) },
    { label: t('org_noDept'), list: others.filter((p) => !p.departmentId) },
    { label: t('org_otherDepts'), list: others.filter((p) => p.departmentId && p.departmentId !== dept) },
  ].filter((g) => g.list.length);
  const deptLabel = (id: number | null) => meta.departments.find((d) => d.id === id)?.name ?? '';
  return (
    <Dialog
      title={person ? person.name : t('org_add')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>
            {t('save')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('op_newName')} className="span-2">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('op_newEmail')}>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('org_position')}>
          <input className="input" value={position} onChange={(e) => setPosition(e.target.value)} />
        </Field>
        <Field label={t('responsibleDept')}>
          <select className="select" value={dept} onChange={(e) => setDept(e.target.value ? Number(e.target.value) : '')}>
            <option value="">-</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {lang === 'ar' && d.nameAr ? d.nameAr : d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('org_manager')}>
          <select className="select" value={manager} onChange={(e) => setManager(e.target.value ? Number(e.target.value) : '')}>
            <option value="">-</option>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {g.label === t('org_otherDepts') ? ` · ${deptLabel(p.departmentId)}` : p.position && !p.departmentId ? ` · ${p.position}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label={t('org_boardTitle')} hint={t('org_boardHint')}>
          <input className="input" value={boardTitle} onChange={(e) => setBoardTitle(e.target.value)} />
        </Field>
        <Field label={t('org_boardRank')}>
          <input className="input num" type="number" min={1} value={boardRank} onChange={(e) => setBoardRank(e.target.value)} />
        </Field>
        <label className="field span-2" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>{t('org_active')}</span>
        </label>
      </div>
    </Dialog>
  );
}
