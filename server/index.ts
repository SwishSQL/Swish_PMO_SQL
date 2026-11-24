import './env';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { db, dbKind, initDb } from './db';
import { HttpError, requireAuth } from './auth';
import { inboundRouter } from './routes/inbound';
import { authRouter } from './routes/auth';
import { metaRouter } from './routes/meta';
import { projectsRouter } from './routes/projects';
import { attachmentsRouter } from './routes/attachments';
import { exportRouter } from './routes/export';
import { followupRouter } from './routes/followup';
import { notificationsRouter } from './routes/notifications';
import { closureRouter } from './routes/closure';
import { aiRouter } from './routes/ai';
import { askRouter } from './routes/ask';
import { changesRouter } from './routes/changes';
import { transformationRouter } from './routes/transformation';
import { trackerRouter } from './routes/tracker';
import { meetingRouter } from './routes/meeting';
import { applyPlanLinks, seedPlan } from './transformation';
import { startReminderJob } from './notify';
import { runSeeds } from './seed';
import { actionsRouter } from './routes/actions';
import { ownersRouter } from './routes/owners';
import { staffRouter } from './routes/staff';
import { addClosureMilestones } from './service';
import { mentionWatcher } from './mentions';
import { aipmRouter } from './routes/aipm';

const app = express();
const port = Number(process.env.PORT ?? 8090);

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Browser hardening. The page loads only its own scripts, styles and fonts
// (inline style attributes are needed by the animation library and the SVG
// charts), can't be framed by another site, and keeps the URL to itself.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
      "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// The script bundle and the JSON lists are text: compressed they are about a quarter of the size, which is
// most of the wait on a slow or distant connection. Excel and SQL downloads are already compact and skipped.
app.use(compression());
// A request to close a project carries its Delivery Document as a file (base64), so this route takes a larger body.
app.use('/api/projects/:id/closure-request', express.json({ limit: '40mb' }));
// A reply posted by the mail service carries its attachments too.
app.use('/api/inbound', express.json({ limit: '40mb' }));
// A file attached to a milestone (base64, up to 8 MB).
app.use('/api/tasks/:taskId/attachments', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

// Healthy means the database answers too: a load balancer or monitor can
// wait for this before sending traffic, and a dead database shows as unhealthy.
app.get('/api/health', async (_req, res) => {
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('database did not answer in 3s')), 3000)),
    ]);
    res.json({ ok: true, db: dbKind() });
  } catch (error) {
    res.status(503).json({ ok: false, error: (error as Error).message });
  }
});
app.use('/api/auth', authRouter);
// Replies by email come from the mail service, not a signed-in person: the route checks its own secret.
app.use('/api', inboundRouter);
// Everything below needs a session. Checked once here, not once per router.
app.use('/api', requireAuth);
// Text that names someone as @Full Name tells them, once the save went through.
app.use('/api', mentionWatcher);
app.use('/api', metaRouter);
app.use('/api', projectsRouter);
app.use('/api', attachmentsRouter);
app.use('/api', exportRouter);
app.use('/api', followupRouter);
app.use('/api', notificationsRouter);
app.use('/api', closureRouter);
app.use('/api', aiRouter);
app.use('/api', askRouter);
app.use('/api', changesRouter);
app.use('/api', transformationRouter);
app.use('/api', trackerRouter);
app.use('/api', meetingRouter);
app.use('/api', actionsRouter);
app.use('/api', ownersRouter);
app.use('/api', staffRouter);
app.use('/api', aipmRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'The server hit an error. Try again, and tell the PMO if it keeps happening.' });
});

// Built SPA: dist/server/index.js -> dist/client
const clientDir = path.resolve(__dirname, '../client');
if (fs.existsSync(clientDir)) {
  app.use('/assets', express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y' }));
  // A file of an older version is gone: say so (404), never answer with the page itself, which the browser cannot
  // run as code (the open page then reloads itself onto the new version).
  app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('Not found'));
  app.use(express.static(clientDir, { etag: true, maxAge: 0 }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

async function start(): Promise<void> {
  await initDb();
  await runSeeds();
  await seedPlan();
  await applyPlanLinks();
  await addClosureMilestones();
  app.listen(port, () => console.log(`SWiSH PMO listening on :${port}`));
  startReminderJob();
}

// A promise nobody awaited should never take the whole server down: log it
// and keep serving.
process.on('unhandledRejection', (error) => console.error('[server] unhandled rejection', error));

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
