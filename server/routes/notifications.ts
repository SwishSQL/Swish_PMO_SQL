import { Router } from 'express';
import { db } from '../db';
import { route } from '../auth';
import { ensureReminders } from '../notify';
import { mailEnabled } from '../mail';

// The signed-in person's own notifications. Nobody reads another person's.
export const notificationsRouter = Router();

/** How many are unread. Polled by the bell; also where the day's and the week's reminders are made. */
notificationsRouter.get(
  '/notifications/count',
  route(async (req, res) => {
    // Viewing as someone makes nothing for them, not even their daily reminders.
    if (!req.realUser) await ensureReminders(req.user!.id);
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
    res.json({ unread: rows[0].n });
  }),
);

/** Whether work given to me is also emailed to me (my own switch), and whether the server can send mail at all. */
notificationsRouter.get(
  '/notifications/email',
  route(async (req, res) => {
    const { rows } = await db.query('SELECT email_notifications FROM users WHERE id = $1', [req.user!.id]);
    res.json({ enabled: Boolean(rows[0]?.email_notifications), available: mailEnabled() });
  }),
);

notificationsRouter.put(
  '/notifications/email',
  route(async (req, res) => {
    const enabled = req.body?.enabled === true;
    await db.query('UPDATE users SET email_notifications = $2 WHERE id = $1', [req.user!.id, enabled]);
    res.json({ enabled, available: mailEnabled() });
  }),
);

/** The latest 60, newest first, with the project code to show beside each. */
notificationsRouter.get(
  '/notifications',
  route(async (req, res) => {
    await ensureReminders(req.user!.id);
    const { rows } = await db.query(
      `SELECT TOP (60) n.*, p.code AS project_code FROM notifications n LEFT JOIN projects p ON p.id = n.project_id
        WHERE n.user_id = $1 ORDER BY n.created_at DESC, n.id DESC`,
      [req.user!.id],
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        projectId: r.project_id,
        projectCode: r.project_code,
        taskId: r.task_id,
        data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
        createdAt: new Date(r.created_at).toISOString(),
        read: Boolean(r.read_at),
      })),
    );
  }),
);

/** Mark some (ids) or all as read. Only the person's own are touched. */
notificationsRouter.post(
  '/notifications/read',
  route(async (req, res) => {
    const ids: unknown = req.body?.ids;
    if (Array.isArray(ids)) {
      const clean = ids.filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
      await db.query('UPDATE notifications SET read_at = SYSDATETIMEOFFSET() WHERE user_id = $1 AND id IN (SELECT CAST(value AS INT) FROM OPENJSON($2)) AND read_at IS NULL', [req.user!.id, clean]);
    } else {
      await db.query('UPDATE notifications SET read_at = SYSDATETIMEOFFSET() WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
    }
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
    res.json({ unread: rows[0].n });
  }),
);
