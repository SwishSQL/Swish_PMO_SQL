import { useState } from 'react';
import type { OwnerRequest, StaffMember, Task, User } from '../../shared/types';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';

// The owner of a milestone, for whoever runs the project. People of the project's department are given it at once;
// anyone else is asked for: a department (its head picks), a named person (their head approves), or someone without
// an account (a system admin creates it). The PMO gives work to anyone directly.

export function OwnerPicker({
  task,
  users,
  departmentId,
  disabled,
  pending,
  onAssign,
  onChanged,
}: {
  task: Task;
  users: User[];
  departmentId: number | null;
  disabled: boolean;
  pending: OwnerRequest | null;
  onAssign: (user: User | null) => void;
  onChanged: () => void;
}) {
  const { t, lang } = useT();
  const { meta, can } = useApp();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newDept, setNewDept] = useState<number | ''>(departmentId ?? '');
  const [busy, setBusy] = useState(false);
  // The org chart, to fill in someone new (name, email, department) by picking them.
  const { data: staff } = useLoad(() => (adding ? api.get<Pick<StaffMember, 'id' | 'name' | 'email' | 'departmentId' | 'position'>[]>('/api/staff/lookup') : Promise.resolve(null)), [adding]);
  const pmo = can('projects.edit_all');
  const active = users.filter((u) => u.active);
  const ownDept = active.filter((u) => pmo || u.departmentId === departmentId || u.id === task.assigneeId);
  const deptName = (id: number) => {
    const d = meta.departments.find((x) => x.id === id);
    return d ? (lang === 'ar' && d.nameAr ? d.nameAr : d.name) : '';
  };
  const others = pmo
    ? []
    : meta.departments
        .filter((d) => d.id !== departmentId)
        .map((d) => ({ d, people: active.filter((u) => u.departmentId === d.id) }))
        .sort((a, b) => deptName(a.d.id).localeCompare(deptName(b.d.id)));

  const ask = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${task.id}/owner-request`, body);
      toast(t('op_sent'));
      setAdding(false);
      setNewName('');
      setNewEmail('');
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!pending) return;
    try {
      await api.del(`/api/owner-requests/${pending.id}`);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const choose = (v: string) => {
    if (!v) return onAssign(null);
    const [kind, id] = v.split(':');
    if (kind === 'u') return onAssign(users.find((u) => u.id === Number(id)) ?? null);
    if (kind === 'ask') return void ask({ userId: Number(id) });
    if (kind === 'dept') return void ask({ departmentId: Number(id) });
    if (kind === 'new') setAdding(true);
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <select className="select" value={task.assigneeId ? `u:${task.assigneeId}` : ''} disabled={disabled || busy} aria-label={t('owner')} onChange={(e) => choose(e.target.value)}>
        <option value="">{t('unassigned')}</option>
        <optgroup label={pmo ? t('op_everyone') : t('op_yourDept')}>
          {ownDept.map((u) => (
            <option key={u.id} value={`u:${u.id}`}>
              {u.name}
            </option>
          ))}
        </optgroup>
        {others.map(({ d, people }) => (
          <optgroup key={d.id} label={`${deptName(d.id)} · ${d.headUserId ? t('op_headApproves') : t('op_pmoApproves')}`}>
            <option value={`dept:${d.id}`}>{t('op_headPicks', { dept: deptName(d.id) })}</option>
            {people.map((u) => (
              <option key={u.id} value={`ask:${u.id}`}>
                {u.name}
              </option>
            ))}
          </optgroup>
        ))}
        <optgroup label={t('op_notInSystem')}>
          <option value="new:0">{t('op_someoneNew')}</option>
        </optgroup>
      </select>
      {pending && (
        <div className="owner-pending" role="status">
          <span>
            {pending.kind !== 'new' && !meta.departments.find((d) => d.id === pending.departmentId)?.headUserId
              ? t('op_waitPmo', { dept: pending.departmentName })
              : pending.kind === 'department'
              ? t('op_waitDept', { dept: pending.departmentName })
              : pending.kind === 'person'
                ? t('op_waitPerson', { name: pending.userName ?? '', dept: pending.departmentName })
                : t('op_waitNew', { name: pending.userName ?? '' })}
          </span>
          {!disabled && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={withdraw}>
              {t('op_withdraw')}
            </button>
          )}
        </div>
      )}
      {adding && (
        <div className="update-card" style={{ gap: 8 }}>
          <strong style={{ fontSize: 13.5 }}>{t('op_newTitle')}</strong>
          <input
            className="input"
            list="staff-names"
            placeholder={t('op_newName')}
            aria-label={t('op_newName')}
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              const s = (staff ?? []).find((x) => x.name === e.target.value);
              if (s) {
                if (s.email) setNewEmail(s.email);
                if (s.departmentId) setNewDept(s.departmentId);
              }
            }}
          />
          <datalist id="staff-names">
            {(staff ?? [])
              .map((x) => (
                <option key={x.id} value={x.name}>
                  {x.position ?? ''}
                </option>
              ))}
          </datalist>
          <input className="input" type="email" placeholder="name@swishhh.net" aria-label={t('op_newEmail')} value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <select className="select" aria-label={t('responsibleDept')} value={newDept} onChange={(e) => setNewDept(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('op_newDept')}</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {deptName(d.id)}
              </option>
            ))}
          </select>
          <span className="hint">{t('op_newHint')}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-primary btn-sm" disabled={busy || !newName.trim() || !newEmail.trim() || !newDept} onClick={() => ask({ newName: newName.trim(), newEmail: newEmail.trim(), departmentId: newDept })}>
              {t('op_send')}
            </button>
            <button className="btn btn-sm" onClick={() => setAdding(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
