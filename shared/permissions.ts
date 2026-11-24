// What a role can do. Roles are rows in the database and the PMO edits them
// from the Users & permissions screen. Only this catalogue lives in code.

export const PERMISSIONS = [
  { key: 'projects.view_all', group: 'projects' },
  { key: 'projects.create', group: 'projects' },
  { key: 'projects.assign', group: 'projects' },
  { key: 'projects.start_plan', group: 'projects' },
  { key: 'projects.edit_own', group: 'projects' },
  { key: 'projects.edit_all', group: 'projects' },
  { key: 'projects.archive', group: 'projects' },
  { key: 'projects.approve_close', group: 'projects' },
  { key: 'changes.approve', group: 'projects' },
  { key: 'updates.write', group: 'review' },
  { key: 'meeting.run', group: 'review' },
  { key: 'report.view', group: 'review' },
] as const;

// Creating accounts and editing roles is not a permission any role can hold:
// only the owner account (OWNER_EMAIL) does it. See requireOwner on the server.

export type Permission = (typeof PERMISSIONS)[number]['key'];
export const PERMISSION_KEYS: Permission[] = PERMISSIONS.map((p) => p.key);

/** Those who file updates, run the meeting or oversee projects: the Weekly Stand-up and the Dashboard are theirs. A team member reports through their milestones instead. */
export const LEADS_PROJECTS: Permission[] = ['updates.write', 'meeting.run', 'projects.view_all', 'projects.edit_all'];

export const ADMIN_ROLE_ID = 'admin';
export const COMPANY_DOMAIN = '@swishhh.net';

/** Shortest password accepted, the same rule as the old Execution Framework tracker. */
export const MIN_PASSWORD = 10;

/** Roles created on first boot. All but Admin can be edited or removed later. */
export const DEFAULT_ROLES: { id: string; name: string; nameAr: string; permissions: Permission[] }[] = [
  { id: ADMIN_ROLE_ID, name: 'PMO admin', nameAr: 'مسؤول PMO', permissions: PERMISSION_KEYS },
  // The company owner sees everything and hands a project to a department head (by creating it in
  // that department); the head then runs it with a project owner of their choice.
  {
    id: 'company_owner',
    name: 'Company owner',
    nameAr: 'مالك الشركة',
    permissions: ['projects.view_all', 'projects.assign', 'meeting.run', 'report.view'],
  },
  // Only a department head starts projects, and only in the departments they head (Departments tab).
  {
    id: 'dept_head',
    name: 'Department head',
    nameAr: 'رئيس إدارة',
    permissions: ['projects.create', 'projects.edit_own', 'updates.write', 'report.view'],
  },
  {
    id: 'executive',
    name: 'Executive',
    nameAr: 'تنفيذي',
    permissions: ['projects.view_all', 'meeting.run', 'report.view'],
  },
  {
    id: 'pm',
    name: 'Project manager',
    nameAr: 'مدير مشروع',
    // Their own projects only (those they run or work on): the whole portfolio is for the PMO and executives.
    // They start a project from a plan project nobody has started yet, and run it.
    permissions: ['projects.edit_own', 'projects.start_plan', 'updates.write', 'report.view'],
  },
  { id: 'member', name: 'Team member', nameAr: 'عضو فريق', permissions: ['projects.edit_own'] },
];

export function normalizePermissions(raw: unknown): Permission[] {
  const list = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!Array.isArray(list)) return [];
  return PERMISSION_KEYS.filter((k) => list.includes(k));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

export function isCompanyEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e.endsWith(COMPANY_DOMAIN)) return false;
  const local = e.slice(0, -COMPANY_DOMAIN.length);
  return local.length > 0 && !local.includes('@') && !/\s/.test(local);
}
