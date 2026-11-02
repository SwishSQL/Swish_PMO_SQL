import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from './db';
import type { Queryable } from './db';
import type { Permission, User } from '../shared/types';
import { ADMIN_ROLE_ID, normalizePermissions } from '../shared/permissions';
import { mapUser } from './mappers';
import { projectVisibleSql } from './visibility';

export const SESSION_COOKIE = 'pmo_session';
const SESSION_DAYS = 14;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      perms?: Set<Permission>;
    }
  }
}

/**
 * The owner account is protected: always active, always on the Admin role,
 * so the system can never lock everyone out. Set OWNER_EMAIL on the server.
 */
export function ownerEmail(): string | null {
  const e = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
  return e || null;
}

export function isOwner(email: string): boolean {
  return email.trim().toLowerCase() === ownerEmail();
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(userId: number): Promise<{ token: string; expires: Date }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expires]);
  return { token, expires };
}

// ---- Invite links ------------------------------------------------------------
// A new or reset account is set up only through a one-time link the admin
// sends the person. Knowing someone's email is not enough to claim the
// account. Only a hash of the token is stored, so a database read does not
// leak working links.

export const INVITE_DAYS = 7;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a fresh link token for the account. Any earlier link stops working.
 * issuedBy: the admin who will send it (null from the boot log or the command line).
 */
export async function issueInvite(q: Queryable, userId: number, issuedBy: number | null): Promise<{ token: string; expires: Date }> {
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await q.query('UPDATE users SET invite_token_hash = $2, invite_expires_at = $3, invite_issued_by = $4 WHERE id = $1', [
    userId,
    hashToken(token),
    expires,
    issuedBy,
  ]);
  return { token, expires };
}

export async function destroySession(token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token = $1', [token]);
}

/** Permissions come from the role as it is now, read on every request: a role edit applies at once. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  // Express 4 does not catch a rejected promise from middleware. Without the
  // catch, one failed session lookup (a database blip) took the process down.
  let rows: any[];
  try {
    ({ rows } = await db.query(
      `SELECT u.*, r.permissions AS role_permissions FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE s.token = $1 AND s.expires_at > SYSDATETIMEOFFSET() AND u.active = 1`,
      [token],
    ));
  } catch (error) {
    next(error);
    return;
  }
  if (!rows[0]) {
    res.status(401).json({ error: 'Your session has ended. Sign in again.' });
    return;
  }
  // On the temporary password from the first-sign-in email, the person may only choose their own password
  // (and the page may ask who they are, to show that screen). Nothing else is served until they have.
  if (rows[0].temp_password && !['/password', '/meta'].includes(req.path)) {
    res.status(403).json({ error: 'Choose your own password first.', code: 'password_change_required' });
    return;
  }
  req.user = mapUser(rows[0]);
  req.perms = new Set(normalizePermissions(rows[0].role_permissions));
  next();
}

export function can(req: Request, perm: Permission): boolean {
  return req.perms?.has(perm) ?? false;
}

/** Owner, or a system admin the owner appointed. Roles alone never grant this. */
export function canManageAccounts(req: Request): boolean {
  return !!req.user && req.user.active && (isOwner(req.user.email) || req.user.systemAdmin);
}

/** Accounts and roles: the owner and the system admins the owner appointed. */
export function requireAccountManager(req: Request, res: Response, next: NextFunction): void {
  if (!canManageAccounts(req)) {
    res.status(403).json({ error: 'Only the system owner and system admins can manage accounts and permissions.' });
    return;
  }
  next();
}

/** Things only the owner may do, such as appointing system admins. */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !isOwner(req.user.email)) {
    res.status(403).json({ error: 'Only the system owner can do this.' });
    return;
  }
  next();
}

export function requirePermission(perm: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!can(req, perm)) {
      res.status(403).json({ error: 'Your role does not allow this action.' });
      return;
    }
    next();
  };
}

/** On the project's team, its owner, or the head of its department. */
async function isOnTeam(userId: number, projectId: number): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM projects p WHERE p.id = $1 AND ${projectVisibleSql('p', '$2')}`, [projectId, userId]);
  return rows.length > 0;
}

/** The person who owns the project, or heads its department: the two who run it. */
async function runsProject(userId: number, projectId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM projects p WHERE p.id = $1 AND (p.manager_id = $2
        OR EXISTS (SELECT 1 FROM departments d WHERE d.id = p.department_id AND d.head_user_id = $2))`,
    [projectId, userId],
  );
  return rows.length > 0;
}

/** Edit any project, or the ones you manage or belong to. */
export async function canEditProject(req: Request, projectId: number): Promise<boolean> {
  if (can(req, 'projects.edit_all')) return true;
  return can(req, 'projects.edit_own') && isOnTeam(req.user!.id, projectId);
}

/**
 * Decisions about the project itself: who runs it, the team, stage, budget,
 * quarter, dates, and removing phases or milestones. The PMO (edit-all) or the
 * project's own manager. Team members plan tasks and report progress, but
 * cannot hand the project to themselves or quietly remove commitments.
 */
export async function canGovernProject(req: Request, projectId: number): Promise<boolean> {
  if (can(req, 'projects.edit_all')) return true;
  if (!can(req, 'projects.edit_own')) return false;
  return runsProject(req.user!.id, projectId);
}

/**
 * Whether the person sees the whole plan or only the tasks given to them. The PMO, the viewers of
 * everything (company owner, executives), the project's owner and its department head see all of it;
 * a team member sees, and may change, only their own tasks.
 */
export async function seesWholePlan(req: Request, projectId: number): Promise<boolean> {
  if (can(req, 'projects.view_all') || can(req, 'projects.edit_all')) return true;
  return runsProject(req.user!.id, projectId);
}

/** A task given to this person, as owner or co-owner. */
export async function isMyTask(userId: number, taskId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks t WHERE t.id = $1 AND (t.assignee_id = $2
        OR EXISTS (SELECT 1 FROM task_coowners c WHERE c.task_id = t.id AND c.user_id = $2))`,
    [taskId, userId],
  );
  return rows.length > 0;
}

export async function canViewProject(req: Request, projectId: number): Promise<boolean> {
  if (can(req, 'projects.view_all') || can(req, 'projects.edit_all')) return true;
  return isOnTeam(req.user!.id, projectId);
}

export function seesAllProjects(req: Request): boolean {
  return can(req, 'projects.view_all') || can(req, 'projects.edit_all');
}

/** Wraps an async route so a thrown error becomes a JSON 500 instead of a hang. */
export function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export { ADMIN_ROLE_ID };
