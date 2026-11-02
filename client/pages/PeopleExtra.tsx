import { useState } from 'react';
import { CaretLeft, CaretRight, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import type { Department, Holiday } from '../../shared/types';
import { WEEKEND_DAYS } from '../../shared/calendar';
import { addDays, diffDays, weekday } from '../../shared/dates';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { useT } from '../lib/i18n';
import { deptName, fmtDate, fmtDateTime } from '../lib/format';
import { stagger } from '../lib/motion';
import { Dialog, ErrorState, Field, deptColor } from '../components/ui';

// ---- Departments ----------------------------------------------------------------
// The tracker's Departments page: each department with its head. Names in both languages are editable;
// the code and the colour stay, so nothing that points at a department moves.

export function DepartmentsTab() {
  const { meta, reloadMeta } = useApp();
  const { t, lang } = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<Department> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: projects } = useLoad(() => api.get<{ departmentId: number }[]>('/api/projects'), [], 'projects-all');
  const count = (id: number) => (projects ?? []).filter((p) => p.departmentId === id).length;

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: draft.name, nameAr: draft.nameAr ?? '', headName: draft.headName ?? null, headUserId: draft.headUserId ?? null };
      if (draft.id) await api.patch(`/api/departments/${draft.id}`, body);
      else await api.post('/api/departments', { ...body, code: draft.code });
      await reloadMeta();
      setDraft(null);
      toast(t('saved'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="filters">
        <span className="muted">{t('departmentsHint')}</span>
        <button
          className="btn btn-primary"
          style={{ marginInlineStart: 'auto' }}
          onClick={() => (setError(null), setDraft({ name: '', nameAr: '', code: '', headName: '' }))}
        >
          <Plus size={15} weight="bold" aria-hidden />
          {t('addDepartment')}
        </button>
      </div>
      <div className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('department')}</th>
              <th>{t('deptCode')}</th>
              <th>{t('deptHead')}</th>
              <th>{t('projects')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {meta.departments.map((d, i) => (
              <tr key={d.id} className="enter" style={stagger(Math.min(i, 12))}>
                <td>
                  <span className="swatch" style={{ background: deptColor(d.colorSlot), marginInlineEnd: 8 }} />
                  <strong>{deptName(d, lang)}</strong>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {lang === 'ar' ? d.name : d.nameAr}
                  </div>
                </td>
                <td className="code">{d.code}</td>
                <td>
                  {d.headName ?? <span className="muted">-</span>}
                  {d.headUserId === null && d.headName && <div className="muted" style={{ fontSize: 12 }}>{t('deptHeadNone')}</div>}
                </td>
                <td className="num">{count(d.id)}</td>
                <td style={{ textAlign: 'end' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => (setError(null), setDraft({ ...d }))}>
                    <PencilSimple size={14} aria-hidden />
                    {t('edit')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {draft && (
        <Dialog
          title={draft.id ? t('editDepartment') : t('addDepartment')}
          onClose={() => setDraft(null)}
          width={500}
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
              <button className="btn btn-primary" disabled={busy || !draft.name?.trim() || (!draft.id && !draft.code?.trim())} onClick={save}>
                {t('save')}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={t('deptNameEn')}>
              <input className="input" value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t('deptNameAr')}>
              <input className="input" dir="rtl" value={draft.nameAr ?? ''} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} />
            </Field>
            <Field label={t('deptHeadAccount')} hint={t('deptHeadHint')} className="span-2">
              <select
                className="select"
                value={draft.headUserId ?? ''}
                onChange={(e) => setDraft({ ...draft, headUserId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">{t('deptHeadNone')}</option>
                {meta.users
                  .filter((u) => u.active)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </Field>
            {draft.headUserId == null && (
              <Field label={t('deptHead')} className="span-2">
                <input className="input" value={draft.headName ?? ''} onChange={(e) => setDraft({ ...draft, headName: e.target.value })} />
              </Field>
            )}
            {!draft.id && (
              <Field label={t('deptCode')} hint={t('deptCodeHint')}>
                <input className="input" dir="ltr" maxLength={12} value={draft.code ?? ''} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} />
              </Field>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

// ---- Working calendar ---------------------------------------------------------------
// Friday and Saturday are off; the official holidays are kept here. The plan counts working days on
// this calendar and a successor pushed along lands on a working day.

interface HolidayGroup {
  name: string;
  nameAr: string;
  days: string[];
}

/** Consecutive days with the same name are one holiday (Eid is three rows, shown once). */
function groupHolidays(list: Holiday[]): HolidayGroup[] {
  const out: HolidayGroup[] = [];
  for (const h of list) {
    const last = out[out.length - 1];
    if (last && last.name === h.name && diffDays(last.days[last.days.length - 1], h.date) === 1) last.days.push(h.date);
    else out.push({ name: h.name, nameAr: h.nameAr, days: [h.date] });
  }
  return out;
}

export function CalendarTab() {
  const { meta, reloadMeta } = useApp();
  const { t, lang } = useT();
  const toast = useToast();

  const [draft, setDraft] = useState<{ from: string; to: string; name: string; nameAr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = groupHolidays(meta.holidays ?? []);
  const years = [...new Set(groups.map((g) => g.days[0].slice(0, 4)))].sort().reverse();

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/holidays', { from: draft.from, to: draft.to || draft.from, name: draft.name, nameAr: draft.nameAr });
      await reloadMeta();
      setDraft(null);
      toast(t('saved'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (g: HolidayGroup) => {
    if (!window.confirm(t('holidayRemoveConfirm', { name: (lang === 'ar' && g.nameAr) || g.name }))) return;
    try {
      await api.post('/api/holidays/remove', { days: g.days });
      await reloadMeta();
      toast(t('saved'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  const span = draft?.from ? diffDays(draft.from, draft.to || draft.from) + 1 : 0;
  return (
    <>
      <div className="filters">
        <span className="muted">{t('calendarHint')}</span>
        <button
          className="btn btn-primary"
          style={{ marginInlineStart: 'auto' }}
          onClick={() => (setError(null), setDraft({ from: '', to: '', name: '', nameAr: '' }))}
        >
          <Plus size={15} weight="bold" aria-hidden />
          {t('addHoliday')}
        </button>
      </div>
      <div className="panel panel-body" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <strong style={{ fontWeight: 600 }}>{t('weekendLabel')}</strong>
        <span className="pill">{t('weekendDays')}</span>
        <span className="muted" style={{ fontSize: 13 }}>
          {t('weekendFixed')}
        </span>
      </div>
      {groups.length === 0 ? (
        <div className="panel panel-body muted">{t('noHolidays')}</div>
      ) : (
        years.map((y) => (
          <div key={y} style={{ marginBottom: 18 }}>
            <h3 className="num" style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: 'var(--ink-2)' }}>
              {y}
            </h3>
            <div className="panel table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('holidayName')}</th>
                    <th>{t('holidayDates')}</th>
                    <th className="num">{t('holidayDaysCol')}</th>
                    <th className="num">{t('holidayWorkLost')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {groups
                    .filter((g) => g.days[0].startsWith(y))
                    .map((g, i) => {
                      const first = g.days[0];
                      const last = g.days[g.days.length - 1];
                      const lost = g.days.filter((d) => !WEEKEND_DAYS.includes(weekday(d))).length;
                      const past = last < meta.today;
                      return (
                        <tr key={first} className="enter" style={{ ...stagger(Math.min(i, 12)), opacity: past ? 0.6 : 1 }}>
                          <td>
                            <strong style={{ fontWeight: 500 }}>{(lang === 'ar' && g.nameAr) || g.name}</strong>
                            {g.nameAr && (
                              <div className="muted" style={{ fontSize: 12.5 }}>
                                {lang === 'ar' ? g.name : g.nameAr}
                              </div>
                            )}
                          </td>
                          <td className="num" style={{ whiteSpace: 'nowrap' }}>
                            {first === last ? fmtDate(first, lang) : `${fmtDate(first, lang)} - ${fmtDate(last, lang)}`}
                            {past && <span className="muted"> · {t('holidayPast')}</span>}
                          </td>
                          <td className="num">{g.days.length}</td>
                          <td className="num">{lost}</td>
                          <td style={{ textAlign: 'end' }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => remove(g)} aria-label={`${t('remove')} ${g.name}`}>
                              <Trash size={14} aria-hidden />
                              {t('remove')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
      {draft && (
        <Dialog
          title={t('addHoliday')}
          onClose={() => setDraft(null)}
          width={500}
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
              <button
                className="btn btn-primary"
                disabled={busy || !draft.name.trim() || !draft.from || (!!draft.to && draft.to < draft.from) || span > 31}
                onClick={save}
              >
                {t('save')}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={t('holidayNameEn')}>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t('holidayNameAr')}>
              <input className="input" dir="rtl" value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} />
            </Field>
            <Field label={t('holidayFrom')}>
              <input className="input" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </Field>
            <Field
              label={t('holidayTo')}
              hint={span > 0 && span <= 31 ? t('holidaySpan', { n: span, w: weekdaysIn(draft.from, draft.to || draft.from) }) : t('holidayToHint')}
            >
              <input className="input" type="date" min={draft.from || undefined} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </Field>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Sunday-to-Thursday days in the range: the working days a holiday there takes. */
function weekdaysIn(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!WEEKEND_DAYS.includes(weekday(d))) n++;
  return n;
}

// ---- Activity log -----------------------------------------------------------------
// Everything the system records, newest first: who did what, where, when. For the owner and system admins.

interface AuditRow {
  id: number;
  action: string;
  detail: Record<string, any>;
  at: string;
  userId: number | null;
  userName: string | null;
  projectId: number | null;
  projectCode: string | null;
}
interface AuditPage {
  total: number;
  page: number;
  pages: number;
  groups: string[];
  rows: AuditRow[];
}

const LABELS: Record<string, [string, string]> = {
  'project.created': ['Created a project', 'أنشأ مشروعًا'],
  'project.updated': ['Changed a project', 'عدّل مشروعًا'],
  'project.archived': ['Archived a project', 'أرشف مشروعًا'],
  'project.imported': ['Imported from the tracker', 'استورد من المتتبع'],
  'task.created': ['Added to a plan', 'أضاف إلى خطة'],
  'task.moved': ['Moved in a plan', 'حرّك في خطة'],
  'task.progress': ['Changed progress', 'غيّر الإنجاز'],
  'task.deleted': ['Deleted from a plan', 'حذف من خطة'],
  'dependency.added': ['Linked two tasks', 'ربط مهمتين'],
  'baseline.set': ['Set the baseline', 'ثبّت خط الأساس'],
  'baseline.filled': ['Baselined new items', 'ثبّت خط الأساس لبنود جديدة'],
  'baseline.reset': ['Re-baselined a project', 'أعاد ضبط خط الأساس'],
  'update.submitted': ['Filed a weekly update', 'سلّم تحديثًا أسبوعيًا'],
  'team.updated': ['Changed a team', 'عدّل فريقًا'],
  'deadline.approved': ['Approved a deadline change', 'اعتمد تغيير موعد'],
  'deadline.rejected': ['Rejected a deadline change', 'رفض تغيير موعد'],
  'escalation.raised': ['Raised an escalation', 'رفع تصعيدًا'],
  'escalation.resolved': ['Closed an escalation', 'أغلق تصعيدًا'],
  'user.created': ['Added an account', 'أضاف حسابًا'],
  'user.updated': ['Changed an account', 'عدّل حسابًا'],
  'user.activated': ['Set up an account', 'جهّز حسابه'],
  'user.password_emailed': ['Was emailed a first password', 'أُرسلت إليه كلمة مرور أولى'],
  'user.deleted': ['Deleted an account', 'حذف حسابًا'],
  'user.password_reset': ['Reset a password', 'أعاد تعيين كلمة مرور'],
  'user.invite_link': ['Made a new setup link', 'أنشأ رابط تجهيز جديد'],
  'role.created': ['Added a role', 'أضاف دورًا'],
  'role.updated': ['Changed a role', 'عدّل دورًا'],
  'role.deleted': ['Deleted a role', 'حذف دورًا'],
  'department.created': ['Added a department', 'أضاف قسمًا'],
  'department.updated': ['Changed a department', 'عدّل قسمًا'],
  'holiday.added': ['Added a holiday', 'أضاف عطلة رسمية'],
  'holiday.removed': ['Removed a holiday', 'أزال عطلة رسمية'],
  'backup.downloaded': ['Downloaded a backup', 'نزّل نسخة احتياطية'],
  'directory.merged': ['Merged two names', 'دمج اسمين'],
};

const GROUPS: Record<string, [string, string]> = {
  project: ['Projects', 'المشاريع'],
  task: ['Plans and tasks', 'الخطط والمهام'],
  dependency: ['Task links', 'روابط المهام'],
  baseline: ['Baselines', 'خطوط الأساس'],
  update: ['Weekly updates', 'التحديثات الأسبوعية'],
  team: ['Teams', 'الفرق'],
  deadline: ['Deadline changes', 'تغييرات المواعيد'],
  escalation: ['Escalations', 'التصعيدات'],
  user: ['Accounts', 'الحسابات'],
  role: ['Roles', 'الأدوار'],
  department: ['Departments', 'الأقسام'],
  backup: ['Backups', 'النسخ الاحتياطية'],
  holiday: ['Holidays', 'العطلات الرسمية'],
  directory: ['Directory', 'الدليل'],
  risk: ['Risks and issues', 'المخاطر والمشكلات'],
};

/** A short, readable line from what the record kept. */
function summary(a: AuditRow, lang: 'en' | 'ar'): string {
  const d = a.detail ?? {};
  const bits: string[] = [];
  if (d.name) bits.push(`"${d.name}"`);
  if (d.email) bits.push(String(d.email));
  if (d.title) bits.push(`"${d.title}"`);
  if (a.action === 'department.updated' && d.from && d.to) {
    const diff = ['name', 'nameAr', 'head'].filter((k) => d.from[k] !== d.to[k]).map((k) => `${k}: ${d.from[k] ?? '-'} → ${d.to[k] ?? '-'}`);
    bits.push(diff.join(', '));
  }
  if (a.action === 'project.updated') {
    if (d.healthFrom) bits.push(`${d.healthFrom} → ${d.health}`);
    if (d.stageFrom) bits.push(`${d.stageFrom} → ${d.stage}`);
    if (Array.isArray(d.fields) && d.fields.length) bits.push(d.fields.join(', '));
  }
  if (a.action === 'baseline.reset' && d.reason) bits.push(`${lang === 'ar' ? 'السبب' : 'reason'}: ${d.reason}`);
  if ((a.action.startsWith('deadline.') || a.action === 'task.moved') && (d.from || d.to)) bits.push(`${[].concat(d.from ?? []).join(' - ')} → ${[].concat(d.to ?? []).join(' - ')}`);
  if (a.action.startsWith('holiday.') && d.from) bits.push(d.from === d.to ? d.from : `${d.from} → ${d.to}`);
  if (a.action === 'escalation.raised') bits.push(`${lang === 'ar' ? 'المستوى' : 'level'} ${d.level} → ${d.to}`);
  if (a.action === 'user.created') bits.push(`${d.roleId ?? ''}${d.systemAdmin ? ' (system admin)' : ''}`);
  if (a.action === 'user.activated' && d.linkFrom) bits.push(`${lang === 'ar' ? 'برابط من' : 'link from'} ${d.linkFrom}`);
  return bits.filter(Boolean).join(' · ');
}

export function ActivityTab() {
  const { meta } = useApp();
  const { t, lang } = useT();
  const [group, setGroup] = useState('');
  const [user, setUser] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), ...(group && { group }), ...(user && { user }), ...(from && { from }), ...(to && { to }) }).toString();
  const { data, error, reload } = useLoad(() => api.get<AuditPage>(`/api/audit?${qs}`), [qs]);
  const reset = (fn: () => void) => () => (fn(), setPage(1));

  if (error) return <ErrorState message={error} onRetry={reload} />;
  const label = (action: string) => LABELS[action]?.[lang === 'ar' ? 1 : 0] ?? action.replace('.', ' ');

  return (
    <>
      <div className="filters">
        <select className="select" style={{ width: 'auto' }} aria-label={t('activityGroup')} value={group} onChange={(e) => (setGroup(e.target.value), setPage(1))}>
          <option value="">{t('activityAll')}</option>
          {(data?.groups ?? []).map((g) => (
            <option key={g} value={g}>
              {GROUPS[g]?.[lang === 'ar' ? 1 : 0] ?? g}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 'auto' }} aria-label={t('activityUser')} value={user} onChange={(e) => (setUser(e.target.value), setPage(1))}>
          <option value="">{t('activityAnyone')}</option>
          {meta.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <input className="input" type="date" style={{ width: 'auto' }} aria-label={t('activityFrom')} value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
        <input className="input" type="date" style={{ width: 'auto' }} aria-label={t('activityTo')} value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
        {(group || user || from || to) && (
          <button className="btn btn-ghost btn-sm" onClick={reset(() => (setGroup(''), setUser(''), setFrom(''), setTo('')))}>
            {t('clearFilters')}
          </button>
        )}
        <span className="muted num" style={{ marginInlineStart: 'auto', fontSize: 13 }}>
          {data ? t('activityCount', { n: data.total }) : ''}
        </span>
      </div>
      <div className="panel table-wrap">
        {!data ? (
          <div className="skeleton" style={{ height: 320, borderRadius: 14 }} />
        ) : data.rows.length === 0 ? (
          <div className="panel-body muted">{t('activityNone')}</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('activityWhen')}</th>
                <th>{t('activityWho')}</th>
                <th>{t('activityWhat')}</th>
                <th>{t('project')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((a) => (
                <tr key={a.id}>
                  <td className="num" style={{ whiteSpace: 'nowrap', fontSize: 13 }}>
                    {fmtDateTime(a.at, lang)}
                  </td>
                  <td>{a.userName ?? <span className="muted">{t('activitySystem')}</span>}</td>
                  <td style={{ minWidth: 280 }}>
                    <strong style={{ fontWeight: 500 }}>{label(a.action)}</strong>
                    <div className="muted clamp-2" style={{ fontSize: 12.5 }}>
                      {summary(a, lang)}
                    </div>
                  </td>
                  <td className="code">{a.projectId ? <a href={`#/projects/${a.projectId}/activity`}>{a.projectCode}</a> : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && data.pages > 1 && (
        <div className="pager">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('back')}>
            <CaretLeft size={14} style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} />
          </button>
          <span className="num muted">{t('activityPage', { p: data.page, n: data.pages })}</span>
          <button className="btn btn-sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)} aria-label={t('next')}>
            <CaretRight size={14} style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} />
          </button>
        </div>
      )}
    </>
  );
}
