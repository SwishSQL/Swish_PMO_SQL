// End to end through the API: the real server on an empty SQL Server database made for the run (and dropped after),
// no company data. The login in TEST_MSSQL_* may create databases (see docs/DEPLOY-IT.md, local testing). Covers the rules that matter most: who may do what, deadline changes and their approval,
// notifications, and the working calendar. Run with `npm test`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sql from 'mssql';
import { addDays, todayIso, weekStart, weekday } from '../shared/dates';
import { replyTag } from '../server/inbound';

const ROOT = path.resolve(__dirname, '..');
const INBOUND_SECRET = 'test-inbound-secret-0123456789';
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let testDb = '';

// The server under test gets its own database on a SQL Server the tester provides (TEST_MSSQL_HOST, _PORT, _USER, _PASSWORD).
const admin = () => ({ server: process.env.TEST_MSSQL_HOST || 'localhost', port: Number(process.env.TEST_MSSQL_PORT || 1433), user: process.env.TEST_MSSQL_USER, password: process.env.TEST_MSSQL_PASSWORD, database: 'master', options: { encrypt: false, trustServerCertificate: true } });
async function adminRun(text: string) {
  const pool = await new sql.ConnectionPool(admin()).connect();
  try {
    await pool.request().batch(text);
  } finally {
    await pool.close();
  }
}
let ownerToken = '';
let log = '';

// A stand-in for the Anthropic API: the real SDK code in the server talks to this, so no network and no key.
// Tests set aiAnswer to what the "model" should say, and read aiCalls to see what the server sent it.
let aiAnswer: any = { reply: '', assumptions: [], draft: {} };
let aiStop = 'end_turn';
/** When set, the stand-in refuses a request that carries the optional settings (as a model that does not take them would). */
let aiRejectOptional = false;
const aiCalls: any[] = [];
let aiServer: http.Server;

// A stand-in for the mail server (Microsoft 365 in production): it speaks just enough SMTP to take a message and
// keeps what it was given. Nothing here is a real mailbox or a real password.
interface Mail { from: string; to: string[]; raw: string }
const mails: Mail[] = [];
let smtpRefuse = false;
let smtpServer: net.Server;
let smtpPort = 0;
let aiPort = 0;

before(async () => {
  smtpServer = net.createServer((sock) => {
    let buf = '';
    let mail: Mail | null = null;
    let data = false;
    let loginStep = 0;
    const say = (l: string) => sock.write(l + '\r\n');
    say('220 test ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mail!.raw = buf.slice(0, end);
          buf = buf.slice(end + 5);
          data = false;
          mails.push(mail!);
          say('250 queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (loginStep === 1) { loginStep = 2; say('334 UGFzc3dvcmQ6'); }
        else if (loginStep === 2) { loginStep = 0; say('235 ok'); }
        else if (up.startsWith('EHLO') || up.startsWith('HELO')) say('250-test\r\n250 AUTH PLAIN LOGIN');
        else if (up.startsWith('AUTH LOGIN')) { loginStep = 1; say('334 VXNlcm5hbWU6'); }
        else if (up.startsWith('AUTH')) say('235 ok');
        else if (up.startsWith('MAIL FROM')) { mail = { from: line, to: [], raw: '' }; say('250 ok'); }
        else if (up.startsWith('RCPT TO')) {
          if (smtpRefuse) say('550 no such mailbox');
          else { mail!.to.push(line.replace(/^RCPT TO:\s*<?|>?\s*$/gi, '')); say('250 ok'); }
        }
        else if (up === 'DATA') { data = true; say('354 go'); }
        else if (up === 'QUIT') { say('221 bye'); sock.end(); }
        else say('250 ok');
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => smtpServer.listen(0, '127.0.0.1', () => r()));
  smtpPort = (smtpServer.address() as { port: number }).port;

  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        aiCalls.push(JSON.parse(body));
      } catch {
        aiCalls.push({ unreadable: body });
      }
      res.setHeader('content-type', 'application/json');
      const last = aiCalls[aiCalls.length - 1];
      if (aiRejectOptional && (last.thinking || last.fallbacks)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking: not supported on this model' } }));
        return;
      }
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(aiAnswer) }],
          stop_reason: aiStop,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((r) => aiServer.listen(0, '127.0.0.1', () => r()));
  aiPort = (aiServer.address() as { port: number }).port;

  dir = mkdtempSync(path.join(tmpdir(), 'pmo-test-'));
  testDb = `pmo_test_${randomBytes(4).toString('hex')}`;
  await adminRun(`CREATE DATABASE [${testDb}]`);
  // Compatibility level 150 is SQL Server 2019: the port must not use anything newer (IS DISTINCT FROM, GREATEST, DATETRUNC, ...).
  await adminRun(`ALTER DATABASE [${testDb}] SET COMPATIBILITY_LEVEL = 150`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    OWNER_EMAIL: 'owner.test@swishhh.net',
    OWNER_NAME: 'Test Owner',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${aiPort}`,
    NO_REMINDER_JOB: '1',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    SMTP_USER: 'pmo-test@swishhh.net',
    SMTP_PASS: 'not-a-real-password',
    SMTP_INSECURE: '1',
    INBOUND_ADDRESS: 'abc123@inbound.example.test',
    INBOUND_SECRET: INBOUND_SECRET,
    FOLLOWUP_ENABLED: '1',
    ALLOW_TEST_CLOCK: '1',
    RECOMMEND_PER_DAY: '50',
    // Set on purpose: a password email must never be copied to a list.
    MAIL_CC: 'copy-list@swishhh.net',
    MSSQL_HOST: admin().server,
    MSSQL_PORT: String(admin().port),
    MSSQL_USER: admin().user,
    MSSQL_PASSWORD: admin().password,
    MSSQL_DATABASE: testDb,
  };
  for (const k of ['DATABASE_URL', 'NODE_ENV', 'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'APP_URL', 'RAILWAY_PUBLIC_DOMAIN']) delete env[k];
  // Started from the temp folder, so no local .env is read.
  server = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'server/index.ts')], { cwd: dir, env });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 90_000);
    const on = (chunk: Buffer) => {
      log += chunk.toString();
      const m = log.match(/#\/activate\/([\w-]+)/);
      if (m) ownerToken = m[1];
      if (ownerToken && /listening on/.test(log)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout!.on('data', on);
    server.stderr!.on('data', on);
    server.on('exit', (code) => reject(new Error(`server exited (${code}):\n${log}`)));
  });
});

after(async () => {
  server?.kill();
  aiServer?.close();
  smtpServer?.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the folder a moment longer; the OS cleans temp */
  }
  await new Promise((r) => setTimeout(r, 500));
  if (testDb) await adminRun(`ALTER DATABASE [${testDb}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${testDb}]`).catch((e) => console.error('could not drop', testDb, e.message));
});

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any; headers: Headers }>;
/**
 * A new project must state every stage and have a milestone in each (shared/stageRequirements). Most tests are
 * about something else: this fills in what they leave out, and a milestone per stage inside their dates, unless
 * the body says complete: false (the test of the rule itself).
 */
function completeProject(body: any): any {
  if (!body || typeof body !== 'object' || body.complete === false) {
    if (body && typeof body === 'object') delete body.complete;
    return body;
  }
  const out = { ...body };
  for (const [k, v] of Object.entries({ sponsor: 'Test Sponsor', objective: 'Deliver the agreed change', problemStatement: 'The current way is slow', scope: 'In: the pilot stores', stakeholders: 'Operations, Finance', businessCase: 'Saves time and cost', budget: '0', resources: 'The project team', riskPlan: 'Weekly risk review', deliverables: 'The working solution', successMetric: 'Adoption rate', successTarget: '90% of stores', acceptanceCriteria: 'Signed off by the sponsor' }))
    if (out[k] === undefined || out[k] === '') out[k] = v;
  const ms = Array.isArray(out.milestones) ? [...out.milestones] : [];
  const phases = ['Initiation', 'Planning', 'Execution', 'Monitoring & Control', 'Closure'];
  const start = out.startDate;
  const end = out.endDate;
  if (start && end) {
    const span = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000));
    phases.forEach((phase, i) => {
      if (!ms.some((m: any) => m.phase === phase)) ms.push({ name: `${phase} gate`, date: addDays(start, Math.floor((span * (i + 1)) / phases.length)), phase });
    });
  }
  out.milestones = ms;
  return out;
}

function client(): Call {
  let cookie = '';
  return async (method, url, body) => {
    if (method === 'POST' && url === '/api/projects') body = completeProject(body);
    const r = await fetch(BASE + url, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON (a file) */
    }
    return { status: r.status, body: parsed, headers: r.headers };
  };
}
const activate = async (c: Call, token: string) => {
  const p = 'T-' + randomBytes(9).toString('base64url');
  const r = await c('POST', '/api/auth/activate', { token, password: p, confirm: p });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
/** The setup link from the latest account email to this address: it reaches the person only. */
function tokenOf(email: string): string {
  const raw = mails.filter((x) => x.to.includes(email) && /#\/activate\//.test(x.raw.replace(/=\r?\n/g, ''))).at(-1)?.raw.replace(/=\r?\n/g, '') ?? '';
  const m = /#\/activate\/([A-Za-z0-9_-]+)/.exec(raw);
  assert.ok(m, `a setup email to ${email}`);
  return m![1];
}

// The cast, set up once and shared by the tests below (they run in order).
const owner = client();
const pm = client();
const member = client();
const outsider = client();
const ids: Record<string, number> = {};
// Plan dates: a Sunday at least three weeks out, so no flag about today interferes.
let sun = addDays(todayIso(), 21);
while (weekday(sun) !== 0) sun = addDays(sun, 1);

test('health answers, and nothing else does without a session', async () => {
  const h = (await fetch(`${BASE}/api/health`).then((r) => r.json())) as { ok: boolean };
  assert.equal(h.ok, true);
  assert.equal((await client()('GET', '/api/projects')).status, 401);
});

test('the owner sets up from the boot-log link; it works once', async () => {
  await activate(owner, ownerToken);
  const again = await client()('POST', '/api/auth/activate', { token: ownerToken, password: 'Another-pass-1', confirm: 'Another-pass-1' });
  assert.notEqual(again.status, 200);
  assert.equal((await owner('GET', '/api/meta')).body.isOwner, true);
});

test('accounts: company email only, and set up by link', async () => {
  const gmail = await owner('POST', '/api/users', { email: 'someone@gmail.com', name: 'Outside', roleId: 'member' });
  assert.equal(gmail.status, 400);
  const firstDept = (await owner('GET', '/api/meta')).body.departments[0].id;
  for (const [key, c, email, name, roleId] of [
    ['pm', pm, 'pm.test@swishhh.net', 'Nora Manager', 'pm'],
    ['member', member, 'member.test@swishhh.net', 'Omar Member', 'member'],
    ['outsider', outsider, 'outsider.test@swishhh.net', 'Zed Outsider', 'member'],
  ] as const) {
    // Everyone is in the first department, the one the test projects belong to: work is given only inside it.
    const u = await owner('POST', '/api/users', { email, name, roleId, departmentId: firstDept });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    ids[key] = u.body.id;
    await activate(c, tokenOf(email));
  }
  assert.equal((await member('POST', '/api/users', { email: 'x.test@swishhh.net', name: 'X', roleId: 'member' })).status, 403);
});

test('a project with a manager, a team and milestones; outsiders cannot see it', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const r = await owner('POST', '/api/projects', {
    name: 'Test rollout',
    departmentId: meta.departments[0].id,
    managerId: ids.pm,
    memberIds: [ids.member],
    startDate: sun,
    endDate: addDays(sun, 60),
    milestones: [
      { name: 'Design signed off', date: addDays(sun, 4) },
      { name: 'Go live', date: addDays(sun, 40) },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.project = r.body.project.id;
  ids.design = r.body.tasks.find((t: any) => t.name === 'Design signed off').id;
  ids.golive = r.body.tasks.find((t: any) => t.name === 'Go live').id;
  // On the team as a plain Member with nothing given to them yet: they do not see it until they have work in it.
  assert.equal((await member('GET', `/api/projects/${ids.project}`)).status, 404);
  assert.ok([403, 404].includes((await outsider('GET', `/api/projects/${ids.project}`)).status));
  assert.equal((await member('GET', '/api/notifications')).body.filter((n: any) => n.kind === 'team.added').length, 1);
});

test('the project owner gives work out; a member changes only what is given to them', async () => {
  // Not given yet: the member can neither change nor even read the milestone.
  assert.equal((await member('PATCH', `/api/tasks/${ids.golive}`, { progress: 10 })).status, 403);
  assert.equal((await member('GET', `/api/tasks/${ids.golive}/changes`)).status, 404);
  assert.equal((await member('POST', `/api/projects/${ids.project}/tasks`, { kind: 'task', name: 'Mine', startDate: sun })).status, 403);
  for (const t of [ids.golive, ids.design]) {
    const r = await pm('PATCH', `/api/tasks/${t}`, { assigneeId: ids.member });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await member('PATCH', `/api/tasks/${ids.golive}`, { assigneeId: ids.outsider })).status, 403);
});

test('milestone attachments: any file, by its owners and the manager, downloaded as a file, removed by its uploader', async () => {
  const b64 = (t: string) => Buffer.from(t).toString('base64');
  assert.equal((await outsider('POST', `/api/tasks/${ids.golive}/attachments`, { name: 'x.txt', data: b64('x') })).status, 403);
  const mine = await member('POST', `/api/tasks/${ids.golive}/attachments`, { name: 'site photo.heic', data: b64('any bytes') });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const byPm = await pm('POST', `/api/tasks/${ids.golive}/attachments`, { name: 'run.exe', data: b64('MZ') });
  assert.equal(byPm.status, 201, 'any kind of file');
  assert.equal((await pm('POST', `/api/tasks/${ids.golive}/attachments`, { name: 'empty.txt', data: '' })).status, 400);
  const list = (await member('GET', `/api/tasks/${ids.golive}/attachments`)).body;
  assert.deepEqual(list.map((a: any) => a.name).sort(), ['run.exe', 'site photo.heic']);
  assert.equal((await outsider('GET', `/api/tasks/${ids.golive}/attachments`)).status, 404);
  const file = await member('GET', `/api/attachments/${mine.body.id}`);
  assert.equal(file.status, 200);
  assert.equal(file.body, 'any bytes');
  assert.equal((await outsider('GET', `/api/attachments/${mine.body.id}`)).status, 404);
  assert.equal((await member('DELETE', `/api/attachments/${byPm.body.id}`)).status, 403, 'not their file');
  assert.equal((await member('DELETE', `/api/attachments/${mine.body.id}`)).status, 200);
  assert.equal((await pm('DELETE', `/api/attachments/${byPm.body.id}`)).status, 200);
  assert.deepEqual((await pm('GET', `/api/tasks/${ids.golive}/attachments`)).body, []);
});

test('moving a milestone needs a reason; a member’s move waits for the manager, who is told', async () => {
  const to = addDays(sun, 42);
  const bare = await member('PATCH', `/api/tasks/${ids.golive}`, { startDate: to });
  assert.equal(bare.status, 400);
  const moved = await member('PATCH', `/api/tasks/${ids.golive}`, { startDate: to, changeReason: 'Vendor delivery slipped' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const changes = (await pm('GET', `/api/tasks/${ids.golive}/changes`)).body;
  const pending = changes.find((c: any) => c.status === 'pending');
  assert.ok(pending, 'a pending change is on record');
  assert.equal(pending.reason, 'Vendor delivery slipped');
  const note = (await pm('GET', '/api/notifications')).body.find((n: any) => n.kind === 'deadline.pending');
  assert.equal(note?.taskId, ids.golive);
  assert.equal((await member('POST', `/api/deadline-changes/${pending.id}/decide`, { decision: 'approve' })).status, 403);
  assert.equal((await outsider('GET', '/api/notifications')).body.length, 0);
  ids.pending = pending.id;
});

test('the manager rejects it: the date goes back and the member hears', async () => {
  const r = await pm('POST', `/api/deadline-changes/${ids.pending}/decide`, { decision: 'reject' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const plan = (await pm('GET', `/api/projects/${ids.project}`)).body;
  assert.equal(plan.tasks.find((t: any) => t.id === ids.golive).endDate, addDays(sun, 40));
  const heard = (await member('GET', '/api/notifications')).body.find((n: any) => n.kind === 'deadline.decided');
  assert.equal(heard?.data.decision, 'reject');
});

test('escalations climb a level each time while the earlier ones are open', async () => {
  const a = await member('POST', `/api/tasks/${ids.design}/escalations`, { toName: 'Nora Manager', note: 'Need sign-off' });
  // The team member raises the first step (to the project manager); only the manager or the PMO takes it higher.
  assert.equal((await member('POST', `/api/tasks/${ids.design}/escalations`, { note: 'Still waiting' })).status, 403);
  const b = await owner('POST', `/api/tasks/${ids.design}/escalations`, { note: 'Still waiting' });
  assert.deepEqual([a.status, b.status], [201, 201]);
  // No program or portfolio manager on this project: their steps are skipped, it goes to the PMO.
  assert.deepEqual([a.body.level, b.body.level], [1, 4]);
  const ladder = (await member('GET', `/api/tasks/${ids.design}/escalation-ladder`)).body;
  assert.deepEqual(ladder.map((x: any) => x.role), ['pm', 'program', 'portfolio', 'pmo', 'ibe', 'ceo']);
  assert.equal(a.body.toName, ladder[0].name, 'level 1 goes to the project manager');
  assert.equal((await outsider('POST', `/api/tasks/${ids.design}/escalations`, { toName: 'X', note: 'n' })).status, 403);
});

test('holidays: kept by admins only, and the schedule steps over them', async () => {
  // Eid on the Sunday and Monday of the second week.
  const eid = { from: addDays(sun, 7), to: addDays(sun, 8), name: 'Eid', nameAr: 'العيد' };
  assert.equal((await pm('POST', '/api/holidays', eid)).status, 403);
  const added = await owner('POST', '/api/holidays', eid);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(added.body.map((h: any) => h.date), [eid.from, eid.to]);
  assert.equal((await member('GET', '/api/meta')).body.holidays.length, 2);

  // A five-day task in the first week, and the design milestone linked after it: it lands on Tuesday.
  const plan = await pm('POST', `/api/projects/${ids.project}/tasks`, { kind: 'task', name: 'Build', startDate: sun, endDate: addDays(sun, 4), parentId: ids.golive });
  const build = plan.body.tasks.find((t: any) => t.name === 'Build' && t.kind === 'task').id;
  const linked = await pm('POST', `/api/projects/${ids.project}/dependencies`, { predecessorId: build, successorId: ids.design });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.tasks.find((t: any) => t.id === ids.design).endDate, addDays(sun, 9));
  // The push is on record as an automatic, approved move.
  const auto = (await pm('GET', `/api/tasks/${ids.design}/changes`)).body.find((c: any) => c.automatic);
  assert.equal(auto?.status, 'approved');

  const removed = await owner('POST', '/api/holidays/remove', { days: [eid.from, eid.to] });
  assert.equal(removed.body.length, 0);
});

test('the project exports to Excel', async () => {
  const r = await fetch(`${BASE}/api/projects/${ids.project}/export.xlsx`);
  assert.equal(r.status, 401);
  const c = await pm('GET', `/api/projects/${ids.project}/export.xlsx`);
  assert.equal(c.status, 200);
});

test('search: sees only your projects, folds Arabic letter forms, and treats % literally', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const ar = await owner('POST', '/api/projects', {
    name: 'Risk office',
    nameAr: 'إدارة المخاطر',
    departmentId: meta.departments[0].id,
    managerId: ids.pm,
    startDate: sun,
    endDate: addDays(sun, 30),
  });
  assert.equal(ar.status, 201, JSON.stringify(ar.body));

  const byName = await member('GET', '/api/search?q=rollout');
  assert.equal(byName.status, 200);
  assert.equal(byName.body.projects.length, 1);
  // The member is on 'Test rollout' only, so 'Risk office' (the PM's) stays hidden from them.
  assert.equal((await member('GET', '/api/search?q=risk')).body.projects.length, 0);
  assert.equal((await pm('GET', '/api/search?q=risk')).body.projects.length, 1);

  // Milestones by name or owner, with where to go.
  const ms = (await member('GET', '/api/search?q=go%20live')).body.milestones;
  assert.equal(ms.length, 1);
  assert.equal(ms[0].projectId, ids.project);

  // 'ادارة' (plain alef, teh marbuta) finds 'إدارة' (hamza alef) and 'اداره' (heh) too.
  for (const q of ['ادارة', 'اداره', 'إدارة']) {
    assert.equal((await owner('GET', `/api/search?q=${encodeURIComponent(q)}`)).body.projects.length, 1, q);
  }

  assert.equal((await outsider('GET', '/api/search?q=rollout')).body.projects.length, 0);
  assert.deepEqual((await owner('GET', '/api/search?q=r')).body, { projects: [], milestones: [] });
  assert.equal((await owner('GET', '/api/search?q=%25%25')).body.projects.length, 0);
  assert.equal((await client()('GET', '/api/search?q=rollout')).status, 401);
});

// ---- The hierarchy: company owner, department head, project owner, employee -------------------------

const head = client();
const cowner = client();
test('only a department head starts a project, in their own department; the company owner hands one over', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const roles = meta.roles.map((r: any) => r.id);
  assert.ok(roles.includes('company_owner') && roles.includes('dept_head'), roles.join(','));
  assert.ok(meta.departments.some((d: any) => d.code === 'CC' && d.name === 'Customer Care' && d.nameAr === 'خدمة العملاء'), 'Customer Care is a department');
  const pmRole = meta.roles.find((r: any) => r.id === 'pm');
  assert.equal(pmRole.permissions.includes('projects.create'), false, 'the old Project manager role cannot start projects');

  for (const [key, c, email, name, roleId] of [
    ['head', head, 'head.test@swishhh.net', 'Hana Head', 'dept_head'],
    ['cowner', cowner, 'cowner.test@swishhh.net', 'Cora Owner', 'company_owner'],
  ] as const) {
    const u = await owner('POST', '/api/users', { email, name, roleId });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    ids[key] = u.body.id;
    await activate(c, tokenOf(email));
  }
  const [dA, dB] = meta.departments;
  const set = await owner('PATCH', `/api/departments/${dA.id}`, { headUserId: ids.head });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.headUserId, ids.head);
  assert.equal(set.body.headName, 'Hana Head');
  ids.deptA = dA.id;
  ids.deptB = dB.id;

  const body = (dept: number, extra: object = {}) => ({
    name: 'Hierarchy ' + Math.random().toString(36).slice(2, 6),
    departmentId: dept,
    startDate: sun,
    endDate: addDays(sun, 30),
    ...extra,
  });
  assert.equal((await member('POST', '/api/projects', body(dA.id))).status, 403, 'an employee cannot start one');
  assert.equal((await pm('POST', '/api/projects', body(dA.id))).status, 403, 'nor a project owner');
  assert.equal((await head('POST', '/api/projects', body(dB.id))).status, 403, 'a head cannot start one in another department');

  const own = await head('POST', '/api/projects', body(dA.id));
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.project.managerId, ids.head, 'the head owns it unless they name someone');
  // The same person is a project owner here and an ordinary employee in "Test rollout".
  const named = await head('POST', '/api/projects', body(dA.id, { managerId: ids.member }));
  assert.equal(named.status, 201);
  assert.equal(named.body.project.managerId, ids.member);
  ids.memberOwned = named.body.project.id;
  const planned = await member('POST', `/api/projects/${ids.memberOwned}/tasks`, { kind: 'milestone', name: 'Planned by its owner', startDate: sun, endDate: sun });
  assert.equal(planned.status, 201, JSON.stringify(planned.body));
  assert.equal((await member('POST', `/api/projects/${ids.project}/tasks`, { kind: 'task', name: 'Not allowed here', startDate: sun, endDate: sun })).status, 403);

  // The company owner starts one in any department: the department head gets it and is told.
  const handed = await cowner('POST', '/api/projects', body(dA.id));
  assert.equal(handed.status, 201, JSON.stringify(handed.body));
  assert.equal(handed.body.project.managerId, ids.head);
  const told = (await head('GET', '/api/notifications')).body.filter((n: any) => n.projectId === handed.body.project.id);
  assert.ok(told.length > 0, 'the head hears about it');
});

test('what each level sees', async () => {
  // The company owner sees everything and changes nothing.
  const all = (await cowner('GET', '/api/projects')).body;
  assert.ok(all.some((p: any) => p.id === ids.project) && all.some((p: any) => p.id === ids.memberOwned));
  assert.equal((await cowner('PATCH', `/api/tasks/${ids.golive}`, { progress: 5 })).status, 403);
  assert.equal((await cowner('PATCH', `/api/projects/${ids.project}`, { name: 'Renamed by the owner' })).status, 403);

  // The department head sees the whole plan of a project in their department they are not on, and runs it.
  const mk = await owner('POST', '/api/projects', {
    name: 'Run by the head',
    departmentId: ids.deptA,
    managerId: ids.pm,
    startDate: sun,
    endDate: addDays(sun, 30),
    milestones: [
      { name: 'Alpha', date: addDays(sun, 5) },
      { name: 'Beta', date: addDays(sun, 9) },
    ],
  });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const pid = mk.body.project.id;
  const seen = (await head('GET', `/api/projects/${pid}`)).body;
  assert.equal(seen.tasks.filter((t: any) => t.kind !== 'summary' && !t.systemKey && !t.name.endsWith(' gate')).length, 2);
  // Team roles come from a fixed list; the project manager is the owner, never picked.
  const mgr = (await head('GET', `/api/projects/${pid}`)).body.project.managerId;
  const notOwner = [ids.pm, ids.member].find((u) => u !== mgr);
  assert.equal((await head('PUT', `/api/projects/${pid}/members`, { members: [{ userId: notOwner, role: 'Project owner' }] })).status, 400, 'not a role of the list');
  assert.equal((await head('PUT', `/api/projects/${pid}/members`, { members: [{ userId: notOwner, role: 'Project manager' }] })).status, 400, 'only the owner is the project manager');
  const team = await head('PUT', `/api/projects/${pid}/members`, { members: [{ userId: ids.pm, role: 'Team lead' }, { userId: ids.member, role: 'Member' }] });
  assert.equal(team.status, 200, JSON.stringify(team.body));
  const roles = Object.fromEntries(team.body.members.map((m: any) => [m.userId, m.role]));
  if (mgr) assert.equal(roles[mgr], 'Project manager', 'the owner is always the project manager');

  // A member sees the whole plan of a project they see, and opens only what is given to them.
  const plain = (ts: any[]) => ts.filter((t: any) => t.kind !== 'summary' && !t.systemKey && !t.name.endsWith(' gate')).map((t: any) => t.name).sort();
  assert.equal((await member('GET', `/api/projects/${pid}`)).status, 404, 'a plain member with no work in it does not see it yet');
  const alpha = seen.tasks.find((t: any) => t.name === 'Alpha');
  await pm('PATCH', `/api/tasks/${alpha.id}`, { assigneeId: ids.member });
  assert.deepEqual(plain((await member('GET', `/api/projects/${pid}`)).body.tasks), ['Alpha', 'Beta'], 'with a milestone, the whole plan');
  const rows = (await member('GET', '/api/milestones')).body.filter((m: any) => m.projectId === pid && !/^Closure documents| gate$/.test(m.name));
  assert.deepEqual(rows.map((m: any) => [m.name, m.openable]), [['Alpha', true], ['Beta', false]], 'all shown, only their own opens');
  assert.equal((await member('GET', '/api/search?q=beta')).body.milestones.length, 0, 'search finds only their own milestones');
  // The owner of the project still sees both.
  assert.equal((await pm('GET', `/api/projects/${pid}`)).body.tasks.filter((t: any) => t.kind !== 'summary' && !t.systemKey && !t.name.endsWith(' gate')).length, 2);
});

// ---- Closing a project --------------------------------------------------------------------------------

test('a project closes only when a PMO admin approves a request', async () => {
  const P = ids.project;
  // No project finishes without its Delivery Document: a link to it, or the file.
  const early = await pm('POST', `/api/projects/${P}/closure-request`, { note: 'x', ...closeDocs() });
  assert.equal(early.status, 400, 'not while milestones are open');
  assert.match(early.body.error, /milestones/);
  await finishMilestones(P);
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { note: 'Everything is delivered' })).status, 400, 'a request needs the closure documents');
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { note: 'x', reportFile: closeDocs().reportFile })).status, 400, 'the signed checklist too');
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { note: 'x', deliveryUrl: 'not a link', ...closeDocs() })).status, 400);
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { note: 'x', deliveryUrl: 'javascript:alert(1)', ...closeDocs() })).status, 400);
  const req1 = await pm('POST', `/api/projects/${P}/closure-request`, { note: 'Everything is delivered', deliveryUrl: 'https://swish.example/sites/pmo/delivery.docx', reportFile: { name: 'Closure Report.pptx', data: Buffer.from('slides').toString('base64') }, checklistFile: { name: 'Signed checklist.jpg', data: Buffer.from('scan').toString('base64') } });
  assert.equal(req1.status, 201, 'any office file or a scan is accepted: ' + JSON.stringify(req1.body));
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { deliveryUrl: 'https://swish.example/again', ...closeDocs() })).status, 409, 'one request at a time');
  assert.equal((await member('POST', `/api/projects/${P}/closure-request`, {})).status, 403, 'an employee cannot even ask');

  // No other door closes it. The stage and the health follow the plan: nobody types them.
  assert.equal((await pm('PATCH', `/api/projects/${P}`, { stage: 'initiation' })).status, 400, 'the stage is not typed');
  assert.equal((await pm('PATCH', `/api/projects/${P}`, { health: 'at_risk' })).status, 400, 'the health is not typed');
  assert.equal((await pm('PATCH', `/api/projects/${P}`, { health: 'done' })).status, 403);
  await pm('PUT', `/api/projects/${P}/updates/${todayIso()}`, { health: 'done', progress: 100 });
  assert.notEqual((await pm('GET', `/api/projects/${P}`)).body.project.health, 'done', 'a weekly update cannot finish it');

  // The PMO admin is told, sees it waiting, and only an approver can decide.
  assert.ok((await owner('GET', '/api/notifications')).body.some((n: any) => n.kind === 'closure.requested' && n.projectId === P));
  const waiting = (await owner('GET', '/api/closure-requests/pending')).body;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].projectId, P);
  assert.equal((await pm('GET', '/api/closure-requests/pending')).status, 403);
  assert.equal((await pm('POST', `/api/closure-requests/${waiting[0].id}/decide`, { decision: 'approve' })).status, 403);

  // Rejected: the project carries on and its owner hears.
  const no = await owner('POST', `/api/closure-requests/${waiting[0].id}/decide`, { decision: 'reject', note: 'Two milestones are still open' });
  assert.equal(no.status, 200, JSON.stringify(no.body));
  let detail = (await pm('GET', `/api/projects/${P}`)).body;
  assert.notEqual(detail.project.health, 'done');
  assert.equal(detail.closure.status, 'rejected');
  assert.equal(detail.closure.decisionNote, 'Two milestones are still open');
  assert.ok((await pm('GET', '/api/notifications')).body.some((n: any) => n.kind === 'closure.decided' && n.data.decision === 'reject'));
  assert.equal((await owner('POST', `/api/closure-requests/${waiting[0].id}/decide`, { decision: 'approve' })).status, 409, 'decided once');

  // Asked again and approved: now it is closed.
  await pm('POST', `/api/projects/${P}/closure-request`, { note: 'Done now', deliveryUrl: 'https://swish.example/final', ...closeDocs() });
  const again = (await owner('GET', '/api/closure-requests/pending')).body[0];
  assert.equal((await owner('POST', `/api/closure-requests/${again.id}/decide`, { decision: 'approve' })).status, 200);
  detail = (await pm('GET', `/api/projects/${P}`)).body;
  assert.equal(detail.project.stage, 'closure');
  assert.equal(detail.project.health, 'done');
  // The closure documents milestone is in the plan, never held up the request, and is done with the approval.
  const docs = detail.tasks.find((t: any) => t.systemKey === 'closure_docs');
  assert.ok(docs, 'every plan has the closure documents milestone');
  assert.equal(docs.status, 'done');
  assert.equal((await owner('DELETE', `/api/tasks/${docs.id}`)).status, 400, 'it cannot be deleted');
  assert.equal((await owner('PATCH', `/api/tasks/${docs.id}`, { status: 'todo' })).status, 400, 'nor edited');
  assert.equal(detail.project.baselineSlip ?? 0, 0, 'adding it is not a slip');
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, {})).status, 409, 'already closed');

  // Those who approve may also close directly, and it is all on the record.
  assert.equal((await owner('PATCH', `/api/projects/${P}`, { stage: 'monitoring', health: 'on_track' })).status, 200);
  assert.equal((await owner('PATCH', `/api/projects/${P}`, { stage: 'closure', health: 'done' })).status, 200);
  const log = (await owner('GET', '/api/audit?group=closure')).body.rows.map((r: any) => r.action);
  assert.ok(['closure.requested', 'closure.rejected', 'closure.approved'].every((a) => log.includes(a)), log.join(','));
});

// ---- The project assistant -----------------------------------------------------------------------------

const say = (text: string) => ({ messages: [{ role: 'user', content: text }] });
/** The system prompt of a call to the stand-in, as text. */
const sysOf = (call: any): string => (typeof call.system === 'string' ? call.system : JSON.stringify(call.system));

test('assistant: only people who may start a project can use it, and the model sees only what they may use', async () => {
  assert.equal((await client()('POST', '/api/ai/project-draft', say('x'))).status, 401);
  assert.equal((await member('GET', '/api/ai/status')).body.enabled, true);
  // An employee may start no project anywhere: refused before the model is ever asked.
  const before = aiCalls.length;
  assert.equal((await member('POST', '/api/ai/project-draft', say('New project: Warehouse'))).status, 403);
  assert.equal(aiCalls.length, before);
  // A project manager starts plan projects, so the assistant helps them too, with every department offered.
  aiAnswer = { reply: 'Filled in.', assumptions: [], draft: { name: 'Plan item', nameAr: '', departmentId: ids.deptA, ownerId: 0, sponsor: '', priority: 'medium', objective: '', scope: '', startDate: sun, endDate: addDays(sun, 30), milestones: [] } };
  assert.equal((await pm('POST', '/api/ai/project-draft', say('Start the plan project Plan item'))).status, 200, 'a project manager may use the assistant');

  aiAnswer = { reply: 'Filled in.', assumptions: [], draft: { name: 'Warehouse', nameAr: '', departmentId: ids.deptA, ownerId: 0, sponsor: '', priority: 'medium', objective: '', scope: '', startDate: sun, endDate: addDays(sun, 30), milestones: [] } };
  const r = await head('POST', '/api/ai/project-draft', say('We have a new project called Warehouse'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const call = aiCalls[aiCalls.length - 1];
  assert.equal(call.model, 'claude-haiku-5-5', 'the fast model is the default');
  assert.deepEqual(call.thinking, { type: 'disabled' }, 'a form needs no thinking, and thinking is the wait');
  assert.ok(call.output_config?.format?.schema, 'a fixed output shape is requested');
  assert.equal(call.output_config.effort, 'low', 'filling a form needs little thinking, which is most of the wait');
  assert.ok(call.max_tokens <= 3000, 'a small ceiling bounds the wait');
  assert.ok(/Write in English only/.test(sysOf(call)), 'the assistant answers in English even to Arabic input');
  const sys = sysOf(call);
  const meta = (await owner('GET', '/api/meta')).body;
  const nameOf = (id: number) => meta.departments.find((d: any) => d.id === id).name;
  assert.ok(sys.includes(`"name": "${nameOf(ids.deptA)}"`), 'the head own department is offered');
  assert.ok(!sys.includes(`"name": "${nameOf(ids.deptB)}"`), 'another department is not');
  assert.ok(!/@swishhh\.net/.test(sys), 'no email address goes to the model');
  assert.ok(sys.includes('Hana Head'), 'people are offered by name');

  // The company owner may start one anywhere: every department is offered.
  await cowner('POST', '/api/ai/project-draft', say('A project'));
  const wide = sysOf(aiCalls[aiCalls.length - 1]);
  for (const d of meta.departments) assert.ok(wide.includes(`"name": "${d.name}"`), `department ${d.name} offered to the company owner`);
});

test('assistant: whatever the model returns is made safe before it reaches the person', async () => {
  aiAnswer = {
    reply: 'Here is a draft.',
    assumptions: ['I proposed the dates'],
    draft: {
      name: '  Sorting hall  ',
      nameAr: '',
      departmentId: ids.deptB, // not theirs: dropped
      ownerId: 987654, // not a person: dropped
      sponsor: '',
      priority: 'urgent', // not a priority: medium
      objective: 'Faster sorting',
      scope: '',
      startDate: sun,
      endDate: addDays(sun, 30),
      milestones: [
        { name: 'Go live', date: addDays(sun, 100) }, // after the end: pulled back to the end
        { name: 'Design', date: addDays(sun, 5) }, // a Friday: moved to the next working day
        { name: 'Kick-off', date: addDays(sun, -10) }, // before the start: pulled to the start
        { name: '   ', date: addDays(sun, 3) }, // no name: dropped
      ],
    },
  };
  const r = await head('POST', '/api/ai/project-draft', say('Sorting hall project, go live end of the quarter'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.draft;
  assert.equal(d.name, 'Sorting hall');
  assert.equal(d.departmentId, 0);
  assert.equal(d.ownerId, 0);
  assert.equal(d.priority, 'medium');
  assert.deepEqual(r.body.missing, ['department']);
  assert.deepEqual(d.milestones.map((m: any) => m.name), ['Kick-off', 'Design', 'Go live']);
  assert.equal(d.milestones[0].date, sun);
  assert.equal(weekday(d.milestones[1].date) <= 4, true, 'a working day');
  assert.equal(d.milestones[1].date, addDays(sun, 7));
  assert.equal(d.milestones[2].date, addDays(sun, 30));
  assert.deepEqual(r.body.assumptions, ['I proposed the dates']);

  // The person fixes the department by hand, and the next turn carries that draft to the model.
  const turn2 = await head('POST', '/api/ai/project-draft', {
    messages: [
      { role: 'user', content: 'Sorting hall project' },
      { role: 'assistant', content: 'Here is a draft.' },
      { role: 'user', content: 'Add a Testing milestone' },
    ],
    draft: { ...d, departmentId: ids.deptA, name: 'Sorting hall (edited)' },
  });
  assert.equal(turn2.status, 200);
  const sent = sysOf(aiCalls[aiCalls.length - 1]);
  assert.ok(sent.includes('Sorting hall (edited)') && sent.includes(`"departmentId": ${ids.deptA}`), 'the hand edits reach the model');
  assert.equal(aiCalls[aiCalls.length - 1].messages.length, 3);

  // A draft from the browser naming a department that is not theirs is cleaned the same way.
  await head('POST', '/api/ai/project-draft', { ...say('hi'), draft: { name: 'Sneaky', departmentId: ids.deptB, ownerId: 0, priority: 'low', milestones: [] } });
  assert.ok(sysOf(aiCalls[aiCalls.length - 1]).includes('"departmentId": 0'));
});

test('assistant: the draft becomes a project only through the normal creation, with its rules', async () => {
  aiAnswer = { reply: 'Done.', assumptions: [], draft: { name: 'Assistant project', nameAr: '', departmentId: ids.deptA, ownerId: ids.member, sponsor: '', priority: 'high', objective: 'Check the flow', scope: '', startDate: sun, endDate: addDays(sun, 30), milestones: [{ name: 'First', date: addDays(sun, 7) }, { name: 'Second', date: addDays(sun, 14) }] } };
  const r = await head('POST', '/api/ai/project-draft', say('Assistant project'));
  assert.deepEqual(r.body.missing, []);
  const draft = r.body.draft;
  // The page sends the draft to the normal creation, naming the owner as managerId.
  const body = { ...draft, managerId: draft.ownerId || undefined };
  const made = await head('POST', '/api/projects', body);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.project.managerId, ids.member);
  assert.deepEqual(made.body.tasks.filter((t: any) => t.kind !== 'summary' && !t.systemKey && !t.name.endsWith(' gate')).map((t: any) => t.name).sort(), ['First', 'Second']);
  // The same draft, sent by someone who may not start a project there, is refused like any other.
  assert.equal((await member('POST', '/api/projects', body)).status, 403);
});

test('assistant: refusals, cut-off answers and bad input are handled', async () => {
  aiStop = 'refusal';
  assert.equal((await head('POST', '/api/ai/project-draft', say('x'))).status, 422);
  aiStop = 'max_tokens';
  assert.equal((await head('POST', '/api/ai/project-draft', say('x'))).status, 502);
  aiStop = 'end_turn';
  assert.equal((await head('POST', '/api/ai/project-draft', { messages: [] })).status, 400);
  assert.equal((await head('POST', '/api/ai/project-draft', { messages: [{ role: 'assistant', content: 'hi' }] })).status, 400);
  assert.equal((await head('POST', '/api/ai/project-draft', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })).status, 400);
  assert.equal((await head('POST', '/api/ai/project-draft', say('x'.repeat(20001)))).status, 400);
  assert.equal((await head('POST', '/api/ai/project-draft', { messages: [{ role: 'system', content: 'x' }] })).status, 400);
});

test('assistant: each person has an allowance', async () => {
  aiAnswer = { reply: 'ok', assumptions: [], draft: {} };
  let limited = 0;
  for (let i = 0; i < 24; i++) if ((await cowner('POST', '/api/ai/project-draft', say(`n${i}`))).status === 429) limited++;
  assert.ok(limited >= 1, 'the allowance stops a flood');
  // Someone else is not affected.
  assert.equal((await owner('POST', '/api/ai/project-draft', say('hello'))).status, 200);
});

test('weekly draft: written from the reports of the week, only for who files the update, and nothing is saved', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const p = await owner('POST', '/api/projects', { name: 'Weekly draft project', departmentId: meta.departments[0].id, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 60) });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const pid = p.body.project.id;
  const t = (await pm('POST', `/api/projects/${pid}/tasks`, { kind: 'milestone', name: 'Secret-free task', startDate: addDays(sun, 5) })).body;
  const taskId = (t.tasks ?? t.plan?.tasks ?? []).find((x: any) => x.name === 'Secret-free task')?.id;
  assert.ok(taskId, JSON.stringify(t).slice(0, 200));
  assert.equal((await pm('PATCH', `/api/tasks/${taskId}`, { status: 'in_progress', progress: 40, updateComment: 'Supplier chosen', blocker: 'Waiting for the contract' })).status, 200);

  aiAnswer = { health: 'at_risk', accomplishments: '- Supplier chosen.', nextSteps: '- Sign the contract.', blockers: '- Waiting for the contract.', decisions: '' };
  const before = aiCalls.length;
  const r = await pm('POST', `/api/ai/weekly-draft/${pid}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.health, 'at_risk');
  assert.equal(r.body.accomplishments, '- Supplier chosen.');
  assert.equal(r.body.basedOn, 1);
  const sent = JSON.stringify(aiCalls[aiCalls.length - 1]);
  assert.equal(aiCalls.length, before + 1);
  assert.ok(sent.includes('Supplier chosen') && sent.includes('Waiting for the contract'), 'the reports reach the model');
  assert.ok(!sent.includes('pm.test@swishhh.net') && !sent.includes('Nora Manager'), 'no people or emails are sent');
  // Nothing was filed.
  assert.equal((await pm('GET', `/api/projects/${pid}`)).body.updates.length, 0);
  // Only whoever may file the update.
  assert.equal((await member('POST', `/api/ai/weekly-draft/${pid}`)).status, 403);
  // A health the model made up is not accepted.
  aiAnswer = { health: 'on fire', accomplishments: 'x', nextSteps: '', blockers: '', decisions: '' };
  assert.equal((await pm('POST', `/api/ai/weekly-draft/${pid}`)).body.health, 'on_track');
});

test('ask the portfolio: answers from what the person can see, only reads, and links real projects', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const mine = await owner('POST', '/api/projects', { name: 'Askable Alpha', departmentId: meta.departments[0].id, managerId: ids.member, startDate: addDays(sun, -30), endDate: addDays(sun, -3) });
  const theirs = await owner('POST', '/api/projects', { name: 'Hidden Beta Programme', departmentId: meta.departments[1].id, managerId: ids.pm, startDate: addDays(sun, -30), endDate: addDays(sun, -3) });
  assert.equal(mine.status, 201);
  assert.equal(theirs.status, 201);
  const mineId = mine.body.project.id;
  aiAnswer = { answer: 'Alpha is late.', projectIds: [mineId, 999999, mineId] };
  const q = { messages: [{ role: 'user', content: 'Which projects are late and why?' }] };

  // A team member: the model is given only the projects they can see.
  const before = aiCalls.length;
  const r = await member('POST', '/api/ai/ask', q);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.answer, 'Alpha is late.');
  assert.deepEqual(r.body.projects.map((p: any) => p.id), [mineId], 'unknown and repeated ids are dropped');
  assert.equal(aiCalls.length, before + 1);
  const sent = JSON.stringify(aiCalls[aiCalls.length - 1]);
  assert.ok(sent.includes('Askable Alpha'), 'their own project is in the snapshot');
  assert.ok(!sent.includes('Hidden Beta Programme'), 'a project they cannot see is not');

  // The PMO sees both.
  const all = await owner('POST', '/api/ai/ask', q);
  assert.equal(all.status, 200);
  const sentAll = JSON.stringify(aiCalls[aiCalls.length - 1]);
  assert.ok(sentAll.includes('Askable Alpha') && sentAll.includes('Hidden Beta Programme'));

  // A question has a length limit and must come from the person.
  assert.equal((await member('POST', '/api/ai/ask', { messages: [{ role: 'user', content: 'x'.repeat(1501) }] })).status, 400);
  assert.equal((await member('POST', '/api/ai/ask', { messages: [] })).status, 400);
});

test('assistant: a long pasted plan is accepted and its milestones kept', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => `Step ${i + 1} - finish ${addDays(sun, 2 + i)}`).join('\n');
  aiAnswer = {
    reply: 'Read 60 rows.',
    assumptions: ['60 rows read'],
    draft: {
      name: 'Imported plan', nameAr: '', departmentId: ids.deptA, ownerId: 0, sponsor: '', priority: 'medium', objective: '', scope: '',
      startDate: sun, endDate: addDays(sun, 90),
      milestones: Array.from({ length: 60 }, (_, i) => ({ name: `Step ${i + 1}`, date: addDays(sun, 2 + i) })),
    },
  };
  const before = aiCalls.length;
  const r = await head('POST', '/api/ai/project-draft', { messages: [{ role: 'user', content: 'Create the project from this plan:\n' + rows }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.draft.milestones.length, 60, 'more than the old 30-row limit');
  assert.ok(JSON.stringify(aiCalls[before]).includes('PASTED PLANS'), 'the model is told how to read a pasted plan');
});

test('assistant: it asks for what a complete project still lacks, and keeps the phases it was told', async () => {
  aiAnswer = {
    reply: 'I started the draft.',
    questions: ['Which department runs it: Supply Chain or Finance?', 'Who will own it?', '', 'When does it start and end?'],
    assumptions: [],
    draft: { name: 'Cold store', nameAr: '', departmentId: 0, ownerId: 0, sponsor: '', priority: 'medium', objective: '', scope: '', startDate: '', endDate: '', phases: ['Execution', 'Initiation', 'Not a phase'], milestones: [] },
  };
  const before = aiCalls.length;
  const r = await head('POST', '/api/ai/project-draft', say('New project: cold store'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.questions, ['Which department runs it: Supply Chain or Finance?', 'Who will own it?', 'When does it start and end?'], 'the questions reach the person, empty ones dropped');
  assert.deepEqual(r.body.draft.phases, ['Initiation', 'Planning', 'Execution', 'Monitoring & Control', 'Closure'], 'every stage is a phase');
  const sys = JSON.stringify(aiCalls[before]);
  assert.ok(sys.includes('COMPLETE PROJECT') && sys.includes('ASK'), 'the model is told to ask for what is missing');

  // A model that says nothing about phases, or leaves none, keeps them all; no questions means none.
  aiAnswer = { reply: 'Done.', assumptions: [], draft: { name: 'Cold store', departmentId: ids.deptA, phases: [], milestones: [] } };
  const r2 = await head('POST', '/api/ai/project-draft', say('Supply chain'));
  assert.equal(r2.body.draft.phases.length, 5);
  assert.deepEqual(r2.body.questions, []);
});

test('assistant: a model that rejects the optional settings is asked again with the plain request', async () => {
  aiAnswer = { reply: 'ok', assumptions: [], draft: { name: 'Plain retry', departmentId: ids.deptA, startDate: sun, endDate: addDays(sun, 10), milestones: [] } };
  aiRejectOptional = true;
  const before = aiCalls.length;
  const r = await owner('POST', '/api/ai/project-draft', say('retry please'));
  aiRejectOptional = false;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.draft.name, 'Plain retry');
  const [first, second] = aiCalls.slice(before);
  assert.ok(first.thinking && first.fallbacks, 'first the full request');
  assert.ok(!second.thinking && !second.fallbacks && second.output_config.format, 'then the plain one, still with the fixed shape');
});

// ---- First sign-in by email -------------------------------------------------------------------------

/** The text of a mail: its parts decoded (base64 or quoted-printable), so the password can be read out of it. */
function mailText(raw: string): string {
  const out: string[] = [];
  const re = /Content-Transfer-Encoding:\s*(base64|quoted-printable)\r?\n(?:[^\r\n]+\r?\n)*?\r?\n([\s\S]*?)(?:\r?\n--|$)/gi;
  for (const m of raw.matchAll(re)) {
    if (m[1].toLowerCase() === 'base64') out.push(Buffer.from(m[2].replace(/\s+/g, ''), 'base64').toString('utf8'));
    else out.push(Buffer.from(m[2].replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
  }
  return (out.length ? out : [raw]).join('\n');
}
const tempOf = (m: Mail): string => {
  // The password stands alone on an indented line of the decoded body (the headers hold look-alike ids).
  const hit = mailText(m.raw).match(/^ {4}([A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})\s*$/m);
  assert.ok(hit, 'the mail carries a temporary password');
  return hit![1];
};
/** The two documents a project cannot close without (stand-ins). */
/** A project closes only once its milestones are done. */
async function finishMilestones(pid: number) {
  const d = (await owner('GET', `/api/projects/${pid}`)).body;
  for (const t of d.tasks) {
    if (t.kind === 'milestone' && !t.systemKey && t.status !== 'done' && t.status !== 'cancelled' && !t.notRequired) {
      const r = await owner('PATCH', `/api/tasks/${t.id}`, { status: 'done' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  }
}

const closeDocs = () => ({
  reportFile: { name: 'Closure Report.pdf', data: Buffer.from('%PDF report').toString('base64') },
  checklistFile: { name: 'Sign-Off Checklist.pdf', data: Buffer.from('%PDF checklist').toString('base64') },
});
const mailsTo = (email: string) => mails.filter((m) => m.to.includes(email));
/** The setup link of the latest account email to this address. */
const isSetupMail = (m: Mail) => /#\/activate\//.test(m.raw.replace(/=\r?\n/g, ''));
function setupToken(email: string): string {
  const m = mails.filter((x) => x.to.includes(email) && isSetupMail(x)).at(-1);
  assert.ok(m, `a setup email to ${email}`);
  return /#\/activate\/([A-Za-z0-9_-]+)/.exec(m!.raw.replace(/=\r?\n/g, ''))![1];
}
/** The emails with a temporary password (not the account emails). */
const pwMails = (email: string) => mailsTo(email).filter((m) => !isSetupMail(m));
const loginRaw = (email: string, password: string) => client()('POST', '/api/auth/login', { email, password });

test('first sign-in by email: the password goes to the mailbox, is temporary, and must be replaced', async () => {
  assert.equal((await client()('GET', '/api/auth/config')).body.emailSignIn, true);
  const email = 'newhire.test@swishhh.net';
  const created = await owner('POST', '/api/users', { email, name: 'Nadia Newhire', roleId: 'member' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // The account email goes to the person; the admin never sees the link.
  assert.equal(created.body.emailed, true);
  assert.equal(created.body.inviteToken, undefined);
  assert.match(mailText(mailsTo(email).at(-1)!.raw), /account is ready[\s\S]*newhire\.test@swishhh\.net/i);
  const anon = client();

  // Before a password exists, the form says where to go, and nothing can be guessed.
  const early = await loginRaw(email, 'anything-at-all');
  assert.equal(early.status, 403);
  assert.match(early.body.error, /Email me my password/);

  // A stranger's questions all get the same answer, and nothing is sent.
  const before = mails.length;
  for (const e of ['nobody.here@swishhh.net', 'member.test@swishhh.net']) {
    const r = await anon('POST', '/api/auth/first-access', { email: e });
    assert.deepEqual([r.status, r.body], [200, { sent: true }], e);
  }
  assert.equal((await anon('POST', '/api/auth/first-access', { email: 'someone@gmail.com' })).status, 400);
  assert.equal(mails.length, before, 'no mail for an unknown address or for an account that already has its own password');

  // The real one: one email, to that address only, from the system mailbox, never copied.
  const r = await anon('POST', '/api/auth/first-access', { email });
  assert.deepEqual([r.status, r.body], [200, { sent: true }]);
  assert.equal(pwMails(email).length, 1);
  const m = pwMails(email)[0];
  assert.equal(m.to.length, 1);
  assert.match(m.raw, /Subject:[\s\S]*SWiSH[ _]PMO/i, 'the subject names the system');
  assert.ok(!/^cc:/im.test(m.raw) && !/copy-list@/i.test(m.raw), 'a password is never copied to a list');
  assert.match(mailText(m.raw), /Hello Nadia/);
  assert.ok(!/[؀-ۿ]/.test(mailText(m.raw)), 'emails are in English only');
  const temp = tempOf(m);

  // Asking again inside the cool-down changes nothing: still one email, and the first password still works.
  assert.deepEqual((await anon('POST', '/api/auth/first-access', { email })).body, { sent: true });
  assert.equal(pwMails(email).length, 1);

  // It signs in, but only to choose a password of their own.
  assert.equal((await loginRaw(email, 'wrong-wrong-wrong')).status, 401);
  const session = client();
  const login = await session('POST', '/api/auth/login', { email, password: temp });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.mustChangePassword, true);
  const blocked = await session('GET', '/api/projects');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'password_change_required');
  assert.equal((await session('GET', '/api/ai/status')).status, 403);
  const meta = await session('GET', '/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.mustChangePassword, true);

  assert.equal((await session('POST', '/api/auth/password', { current: temp, next: temp })).status, 400, 'not the same one');
  assert.equal((await session('POST', '/api/auth/password', { current: 'not-the-one', next: 'A-New-Password-1' })).status, 400);
  assert.equal((await session('POST', '/api/auth/password', { current: temp, next: 'short' })).status, 400);
  assert.equal((await session('POST', '/api/auth/password', { current: temp, next: 'A-New-Password-1' })).status, 200);

  // Now it is an ordinary account: everything opens, the emailed password is dead, the new one works.
  assert.equal((await session('GET', '/api/projects')).status, 200);
  assert.equal((await session('GET', '/api/meta')).body.mustChangePassword, false);
  assert.equal((await loginRaw(email, temp)).status, 401);
  const again = await loginRaw(email, 'A-New-Password-1');
  assert.equal(again.status, 200);
  assert.equal(again.body.mustChangePassword, false);
  // And a finished account cannot be knocked over by someone asking for an email.
  const mailsBefore = mails.length;
  assert.deepEqual((await anon('POST', '/api/auth/first-access', { email })).body, { sent: true });
  assert.equal(mails.length, mailsBefore);
  assert.equal((await loginRaw(email, 'A-New-Password-1')).status, 200);
  ids.newhire = created.body.id;
});

test('first sign-in by email: if the mail cannot be sent nothing is lost, and the admin can still use a link', async () => {
  const email = 'stuck.test@swishhh.net';
  const created = await owner('POST', '/api/users', { email, name: 'Sami Stuck', roleId: 'member' });
  const anon = client();
  smtpRefuse = true;
  const r = await anon('POST', '/api/auth/first-access', { email });
  smtpRefuse = false;
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(pwMails(email).length, 0);
  // Still waiting for its first sign-in, and the link the admin got still opens the account.
  const stuck = (await owner('GET', '/api/meta')).body.users.find((u: any) => u.email === email);
  assert.equal(stuck.pending, true);
  const opened = await client()('POST', '/api/auth/activate', { token: setupToken(email), password: 'Chosen-By-Link-1', confirm: 'Chosen-By-Link-1' });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
});

test('first sign-in by email: admin reset and the backup link still work', async () => {
  // Reset: the person asks again and a new temporary password is emailed.
  const email = 'newhire.test@swishhh.net';
  const reset = await owner('POST', `/api/users/${ids.newhire}/reset-password`);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal((await loginRaw(email, 'A-New-Password-1')).status, 403, 'no password until they ask');
  // The cool-down of the earlier request does not hold a reset back.
  await client()('POST', '/api/auth/first-access', { email });
  const sent = pwMails(email);
  assert.equal(sent.length, 2, 'a second email after the reset');
  assert.equal((await loginRaw(email, tempOf(sent[1]))).status, 200);

  // While someone is on an emailed password, an admin can replace it with a link: that password stops working.
  const email2 = 'switch.test@swishhh.net';
  const made = await owner('POST', '/api/users', { email: email2, name: 'Sara Switch', roleId: 'member' });
  await client()('POST', '/api/auth/first-access', { email: email2 });
  const temp2 = tempOf(pwMails(email2)[0]);
  const link = await owner('POST', `/api/users/${made.body.id}/invite`);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.equal((await loginRaw(email2, temp2)).status, 403);
  assert.equal((await client()('POST', '/api/auth/activate', { token: setupToken(email2), password: 'Chosen-By-Link-2', confirm: 'Chosen-By-Link-2' })).status, 200);
  // The owner's own first sign-in is by link too (it printed it at boot), as every other test did.
});

// ---- Deleting a person ---------------------------------------------------------------------------------

test('deleting a person: who may, what blocks it, and what it leaves behind', async () => {
  const me = (await owner('GET', '/api/meta')).body.me.id;
  assert.equal((await member('DELETE', `/api/users/${ids.outsider}`)).status, 403, 'an employee cannot delete anyone');
  assert.equal((await owner('DELETE', `/api/users/${me}`)).status, 400, 'nobody deletes their own account');
  assert.equal((await owner('DELETE', '/api/users/999999')).status, 404);

  // Owning a project, or heading a department, blocks it and says what to hand over.
  const owned = await owner('DELETE', `/api/users/${ids.pm}`);
  assert.equal(owned.status, 409, JSON.stringify(owned.body));
  assert.match(owned.body.error, /owns \d+ project/);
  const headed = await owner('DELETE', `/api/users/${ids.head}`);
  assert.equal(headed.status, 409);
  assert.match(headed.body.error, /heads 1 department/);
  const fp = (await owner('GET', `/api/users/${ids.pm}/footprint`)).body;
  assert.ok(fp.projects.length >= 1 && fp.projects[0].code);
  assert.equal((await member('GET', `/api/users/${ids.pm}/footprint`)).status, 403);

  // Someone with open tasks and nothing else: deleted, their tasks become unassigned, the account is gone.
  const email = 'gone.test@swishhh.net';
  const gone = await owner('POST', '/api/users', { email, name: 'Gina Gone', roleId: 'member' });

  // The sign-in email can be corrected after creation: by account managers only, to a free company address.
  assert.equal((await pm('PATCH', `/api/users/${gone.body.id}`, { email: 'gina.new@swishhh.net' })).status, 403);
  assert.equal((await owner('PATCH', `/api/users/${gone.body.id}`, { email: 'gina@gmail.com' })).status, 400);
  const someoneElse = (await owner('GET', '/api/meta')).body.users.find((u: any) => u.id === ids.pm).email;
  assert.equal((await owner('PATCH', `/api/users/${gone.body.id}`, { email: someoneElse })).status, 409);
  const moved = await owner('PATCH', `/api/users/${gone.body.id}`, { email: 'Gina.New@swishhh.net' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.email, 'gina.new@swishhh.net');
  assert.equal((await owner('PATCH', `/api/users/${gone.body.id}`, { email })).status, 200, 'and back');
  const goneClient = client();
  await activate(goneClient, setupToken(email));
  const assigned = await owner('PATCH', `/api/tasks/${ids.design}`, { assigneeId: gone.body.id, status: 'in_progress' });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal((await owner('GET', `/api/users/${gone.body.id}/footprint`)).body.openTasks, 1);
  assert.equal((await goneClient('GET', '/api/projects')).status, 200, 'she is signed in before');

  const removed = await owner('DELETE', `/api/users/${gone.body.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await owner('GET', '/api/meta')).body.users.some((u: any) => u.email === email), false);
  assert.equal((await loginRaw(email, 'anything-at-all-1')).status, 401, 'she cannot sign in');
  assert.equal((await goneClient('GET', '/api/projects')).status, 401, 'her open session ended with the account');
  const plan = (await owner('GET', `/api/projects/${ids.project}`)).body;
  assert.equal(plan.tasks.find((t: any) => t.id === ids.design).assigneeId, null, 'the task is unassigned, not deleted');
  const log = (await owner('GET', '/api/audit?group=user')).body.rows.find((r: any) => r.action === 'user.deleted');
  assert.ok(log && log.detail.email === email && log.detail.tasksUnassigned === 1, 'the deletion is on the record');

  // Someone who never signed in: deleted too, and the link they were given dies with the account.
  const pending = await owner('POST', '/api/users', { email: 'never.test@swishhh.net', name: 'Nora Never', roleId: 'member' });
  assert.equal((await owner('DELETE', `/api/users/${pending.body.id}`)).status, 200);
  const dead = await client()('POST', '/api/auth/activate', { token: setupToken('never.test@swishhh.net'), password: 'Some-Password-123', confirm: 'Some-Password-123' });
  assert.notEqual(dead.status, 200);
  assert.equal((await client()('POST', '/api/auth/first-access', { email: 'never.test@swishhh.net' })).status, 200, 'and asking for her password sends nothing');
});

test('mail check: an admin can test the mail setup and sees what the mail server said', async () => {
  assert.equal((await member('POST', '/api/mail/test')).status, 403, 'only people who manage accounts');
  const before = mails.length;
  const ok = await owner('POST', '/api/mail/test');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.sentTo, 'owner.test@swishhh.net');
  assert.equal(mails.length, before + 1);
  assert.deepEqual(mails[mails.length - 1].to, ['owner.test@swishhh.net']);
  // A server that refuses: the reason reaches the screen (and never the password).
  smtpRefuse = true;
  const bad = await owner('POST', '/api/mail/test');
  smtpRefuse = false;
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /550/);
  assert.ok(!/not-a-real-password/.test(JSON.stringify(bad.body)));
});

test('work is given only to people of the project department; the PMO may cross', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const other = await owner('POST', '/api/users', { email: 'otherdept.test@swishhh.net', name: 'Olga Elsewhere', roleId: 'member', departmentId: meta.departments[1].id });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const plan = (await pm('GET', `/api/projects/${ids.project}`)).body;
  const t = plan.tasks.find((x: any) => x.kind !== 'summary').id;
  const refused = await pm('PATCH', `/api/tasks/${t}`, { assigneeId: other.body.id });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal((await pm('PATCH', `/api/tasks/${t}`, { assigneeId: ids.member })).status, 200);
  assert.equal((await owner('PATCH', `/api/tasks/${t}`, { assigneeId: other.body.id })).status, 200, 'the PMO may give work to any department');
  const team = (await pm('GET', `/api/projects/${ids.project}`)).body.members.map((m: any) => ({ userId: m.userId, role: m.role }));
  assert.equal((await pm('PUT', `/api/projects/${ids.project}/members`, { members: [...team, { userId: other.body.id, role: 'Member' }] })).status, 200, 'anyone may join the team: work across departments is asked for');
  assert.equal((await owner('PUT', `/api/projects/${ids.project}/members`, { members: [...team, { userId: other.body.id, role: 'Member' }] })).status, 200);
});

/** Mail is sent after the request has answered: wait for it to reach the stand-in server. */
async function waitForMail(to: string, since: number, text: string): Promise<Mail> {
  for (let i = 0; i < 60; i++) {
    const hit = mails.slice(since).find((m) => m.to.includes(to) && mailText(m.raw).includes(text));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`no mail to ${to} containing "${text}"`);
}

test('work given to someone is also emailed: a project owner, a task, and not to who switched it off', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const mk = async (email: string, name: string) => {
    const u = await owner('POST', '/api/users', { email, name, roleId: 'member', departmentId: meta.departments[0].id });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    return u.body.id as number;
  };
  const ownerId = await mk('mailowner.test@swishhh.net', 'Mona Mailowner');
  const workerId = await mk('mailworker.test@swishhh.net', 'Wael Mailworker');

  // The project owner hears by email when a project is created with them as owner.
  let since = mails.length;
  const p = await owner('POST', '/api/projects', { name: 'Mail Alpha Programme', departmentId: meta.departments[0].id, managerId: ownerId, startDate: sun, endDate: addDays(sun, 40) });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const pid = p.body.project.id;
  const m1 = await waitForMail('mailowner.test@swishhh.net', since, 'Mail Alpha Programme');
  assert.ok(mailText(m1.raw).includes('made you the owner of the project'), 'the email says what happened');
  assert.ok(await (async () => (await owner('GET', '/api/notifications')).status === 200)());

  // The owner gives a task to an employee: the employee is emailed.
  const gate = (await owner('POST', `/api/projects/${pid}/tasks`, { kind: 'milestone', name: 'Rollout gate', startDate: addDays(sun, 4) })).body;
  const gateId = gate.tasks.find((x: any) => x.name === 'Rollout gate').id;
  const planBody = (await owner('POST', `/api/projects/${pid}/tasks`, { kind: 'task', name: 'Prepare the rollout', startDate: sun, endDate: addDays(sun, 4), parentId: gateId })).body;
  const taskId = (planBody.tasks ?? planBody.plan?.tasks ?? []).find((x: any) => x.name === 'Prepare the rollout')?.id;
  assert.ok(taskId);
  since = mails.length;
  assert.equal((await owner('PATCH', `/api/tasks/${taskId}`, { assigneeId: workerId })).status, 200);
  const m2 = await waitForMail('mailworker.test@swishhh.net', since, 'Prepare the rollout');
  assert.ok(mailText(m2.raw).includes('Mail Alpha Programme'), 'the email names the project');

  // Handing the project to someone else emails the new owner.
  const newOwnerId = await mk('mailowner2.test@swishhh.net', 'Nadim Newowner');
  since = mails.length;
  assert.equal((await owner('PATCH', `/api/projects/${pid}`, { managerId: newOwnerId })).status, 200);
  await waitForMail('mailowner2.test@swishhh.net', since, 'Mail Alpha Programme');

  // A person can switch it off: the in-app notification stays, the email stops.
  assert.deepEqual((await member('GET', '/api/notifications/email')).body, { enabled: true, available: true });
  assert.equal((await member('PUT', '/api/notifications/email', { enabled: false })).body.enabled, false);
  since = mails.length;
  assert.equal((await owner('PATCH', `/api/tasks/${taskId}`, { assigneeId: ids.member })).status, 200);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(mails.slice(since).filter((m) => m.to.includes('member.test@swishhh.net')).length, 0, 'no email after switching it off');
  const note = (await member('GET', '/api/notifications')).body.find((n: any) => n.kind === 'task.assigned' && n.taskId === taskId);
  assert.ok(note, 'the in-app notification is still there');
  assert.equal((await member('PUT', '/api/notifications/email', { enabled: true })).body.enabled, true);
  assert.equal((await owner('PATCH', `/api/tasks/${taskId}`, { assigneeId: workerId })).status, 200);
  assert.equal((await owner('PATCH', `/api/tasks/${taskId}`, { assigneeId: ids.member })).status, 200);
  await waitForMail('member.test@swishhh.net', since, 'Prepare the rollout');
});

test('a new project states every stage and has a milestone in each, or it is not created; its plan has the five phases', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const base = { name: 'Phased project', departmentId: meta.departments[0].id, managerId: ids.pm, sponsor: 'Test Owner', startDate: sun, endDate: addDays(sun, 59) };
  const PHASES = ['Initiation', 'Planning', 'Execution', 'Monitoring & Control', 'Closure'];

  // Half-stated: refused, saying what each stage still lacks.
  const bare = await owner('POST', '/api/projects', { ...base, complete: false, objective: 'Faster stores' });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /Initiation: Problem statement, High-level scope, Key stakeholders, Business case, at least one milestone/);
  assert.match(bare.body.error, /Closure: Acceptance and sign-off, at least one milestone/);
  // A milestone outside the project's dates does not count.
  const outside = await owner('POST', '/api/projects', { ...base, milestones: [{ name: 'Too late', date: addDays(sun, 90), phase: 'Closure' }] });
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /Closure: at least one milestone/);

  // Complete: created, with the five phases in order, each one used, each with its milestone.
  const made = await owner('POST', '/api/projects', base);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pid = made.body.project.id;
  const detail = (await pm('GET', `/api/projects/${pid}`)).body;
  const phases = detail.tasks.filter((t: any) => t.kind === 'summary');
  assert.deepEqual(phases.map((t: any) => t.name), PHASES, 'always all five, in the fixed order');
  assert.equal(phases.filter((t: any) => t.notRequired).length, 0);
  for (const ph of phases) assert.ok(detail.tasks.some((t: any) => t.parentId === ph.id && t.kind === 'milestone'), `${ph.name} has its milestone`);
  assert.equal(detail.project.problemStatement, 'The current way is slow');
  assert.equal(detail.project.acceptanceCriteria, 'Signed off by the sponsor');
  // What a stage stated can be edited afterwards.
  assert.equal((await owner('PATCH', `/api/projects/${pid}`, { stakeholders: 'Operations, Finance, IT' })).status, 200);
  assert.equal((await pm('GET', `/api/projects/${pid}`)).body.project.stakeholders, 'Operations, Finance, IT');
});

test('the delivery document: a file is kept, served only as a download, and only to who can see the project', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const made = await owner('POST', '/api/projects', { name: 'Delivered project', departmentId: meta.departments[0].id, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 30) });
  const pid = made.body.project.id;
  await finishMilestones(pid);
  const pdf = Buffer.from('%PDF-1.4 the delivery report');
  const bad = await pm('POST', `/api/projects/${pid}/closure-request`, { ...closeDocs(), deliveryFile: { name: 'page.html', data: Buffer.from('<script>alert(1)</script>').toString('base64') } });
  assert.equal(bad.status, 400, 'a web page is not accepted as a document');
  const big = await pm('POST', `/api/projects/${pid}/closure-request`, { ...closeDocs(), deliveryFile: { name: 'big.pdf', data: Buffer.alloc(9 * 1024 * 1024, 1).toString('base64') } });
  assert.equal(big.status, 400, 'larger than 8 MB: use a link');
  const ok = await pm('POST', `/api/projects/${pid}/closure-request`, { note: 'Delivered', ...closeDocs(), deliveryFile: { name: 'report.pdf', type: 'text/html', data: pdf.toString('base64') } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const detail = (await pm('GET', `/api/projects/${pid}`)).body;
  assert.equal(detail.closure.deliveryFileName, 'report.pdf');
  assert.equal(detail.closure.deliveryUrl, null);
  assert.ok(!JSON.stringify(detail).includes('JVBERi'), 'the file itself is not inside the project');

  const down = await pm('GET', `/api/closure-requests/${ok.body.id}/document`);
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('content-type'), 'application/pdf', 'the type is the servers own, not the browsers claim');
  assert.match(down.headers.get('content-disposition') ?? '', /^attachment; filename="report.pdf"/);
  assert.equal(down.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(down.body, pdf.toString());
  assert.equal((await outsider('GET', `/api/closure-requests/${ok.body.id}/document`)).status, 404, 'not for someone who cannot see the project');

  const rep = await pm('GET', `/api/closure-requests/${ok.body.id}/document?kind=report`);
  assert.equal(rep.status, 200);
  assert.equal(rep.body, '%PDF report');
  assert.equal((await pm('GET', `/api/closure-requests/${ok.body.id}/document?kind=checklist`)).body, '%PDF checklist');
  assert.equal((await pm('GET', `/api/projects/${pid}`)).body.closure.reportFileName, 'Closure Report.pdf');
  const tpl = await pm('GET', '/api/templates/sign-off-checklist');
  assert.equal(tpl.status, 200);
  assert.match(tpl.headers.get('content-disposition') ?? '', /Sign-Off Checklist Template\.docx/);
  assert.equal((await pm('GET', '/api/templates/..%2F..%2Fpackage.json')).status, 404);
  // The approver sees it in the queue.
  const waiting = (await owner('GET', '/api/closure-requests/pending')).body.find((c: any) => c.projectId === pid);
  assert.equal(waiting.deliveryFileName, 'report.pdf');
});

test('what waits for a decision is emailed: a deadline move to its manager, a closure to the approvers', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const made = await owner('POST', '/api/projects', {
    name: 'Decision Mail Project', departmentId: meta.departments[0].id, managerId: ids.pm, memberIds: [ids.member],
    startDate: sun, endDate: addDays(sun, 40), milestones: [{ name: 'Mail milestone', date: addDays(sun, 10) }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pid = made.body.project.id;
  const ms = (await pm('GET', `/api/projects/${pid}`)).body.tasks.find((t: any) => t.name === 'Mail milestone');
  assert.equal((await pm('PATCH', `/api/tasks/${ms.id}`, { assigneeId: ids.member })).status, 200);

  // A team member asks to move the deadline: the manager is emailed, with the reason.
  let since = mails.length;
  const moved = await member('PATCH', `/api/tasks/${ms.id}`, { endDate: addDays(sun, 14), startDate: addDays(sun, 14), changeReason: 'The supplier is late' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const m1 = await waitForMail('pm.test@swishhh.net', since, 'asks to move the deadline');
  const t1 = mailText(m1.raw);
  assert.ok(t1.includes('Mail milestone') && t1.includes('The supplier is late') && t1.includes('Decision Mail Project'), 'the email carries the task, the reason and the project');
  assert.ok(!/[؀-ۿ]/.test(t1) && !/[؀-ۿ]/.test(m1.raw), 'emails are in English only');

  // The manager asks to close: the approvers are emailed, with the delivery document.
  since = mails.length;
  await finishMilestones(pid);
  const asked = await pm('POST', `/api/projects/${pid}/closure-request`, { note: 'All delivered', deliveryUrl: 'https://swish.example/delivery-report', ...closeDocs() });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const m2 = await waitForMail('owner.test@swishhh.net', since, 'asks to close the project');
  const t2 = mailText(m2.raw);
  assert.ok(t2.includes('Decision Mail Project') && t2.includes('https://swish.example/delivery-report'), 'the email carries the project and the delivery document');
});

test('the plan is phases, milestones inside phases, and tasks inside milestones', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const made = await owner('POST', '/api/projects', {
    name: 'Nested plan', departmentId: meta.departments[0].id, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 99),
    phases: ['Initiation', 'Execution', 'Closure'],
    milestones: [
      { name: 'Charter signed', date: addDays(sun, 3) },
      { name: 'Go live', date: addDays(sun, 30), phase: 'Closure' },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pid = made.body.project.id;
  let plan = (await pm('GET', `/api/projects/${pid}`)).body.tasks;
  const byName = (n: string) => plan.find((t: any) => t.name === n);
  assert.equal(byName('Charter signed').parentId, byName('Initiation').id, 'placed in the phase its date falls in');
  assert.equal(byName('Go live').parentId, byName('Closure').id, 'placed in the phase it names');

  const post = (body: any) => pm('POST', `/api/projects/${pid}/tasks`, { startDate: sun, endDate: addDays(sun, 2), ...body });
  assert.equal((await post({ kind: 'task', name: 'Loose' })).status, 400, 'not at the top of the plan');
  assert.equal((await post({ kind: 'task', name: 'In a phase', parentId: byName('Execution').id })).status, 400, 'not straight inside a phase');
  assert.equal((await post({ kind: 'milestone', name: 'Inside a milestone', parentId: byName('Go live').id })).status, 400);
  const ok = await post({ kind: 'task', name: 'Prepare the charter', parentId: byName('Charter signed').id, endDate: addDays(sun, 45) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await post({ kind: 'milestone', name: 'Build done', parentId: byName('Execution').id })).status, 201);
  plan = (await pm('GET', `/api/projects/${pid}`)).body.tasks;
  assert.equal((await post({ kind: 'task', name: 'Under a task', parentId: byName('Prepare the charter').id })).status, 400, 'not inside another task');

  // Moving and retyping keep the shape.
  const task = byName('Prepare the charter');
  assert.equal((await pm('PATCH', `/api/tasks/${task.id}`, { parentId: byName('Execution').id })).status, 400, 'a task cannot be moved into a phase');
  assert.equal((await pm('PATCH', `/api/tasks/${task.id}`, { parentId: byName('Go live').id })).status, 200, 'but into another milestone');
  assert.equal((await pm('PATCH', `/api/tasks/${byName('Go live').id}`, { kind: 'task' })).status, 400, 'a milestone with tasks in it stays a milestone');

  // The phase spans the work inside its milestones; the milestone keeps its own date.
  plan = (await pm('GET', `/api/projects/${pid}`)).body.tasks;
  assert.equal(byName('Go live').endDate, addDays(sun, 30));
  assert.equal(byName('Closure').endDate, addDays(sun, 45), 'the task after the milestone date widens the phase');
});

test('a department head given a department with no head becomes its head', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const free = meta.departments.find((d: any) => !d.headUserId);
  assert.ok(free, 'a department with no head');
  const first = await owner('POST', '/api/users', { email: 'newhead.test@swishhh.net', name: 'Hadi Newhead', roleId: 'dept_head', departmentId: free.id });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.linkedHeadOf, free.name);
  assert.equal((await owner('GET', '/api/meta')).body.departments.find((d: any) => d.id === free.id).headUserId, first.body.id);

  // A second one does not take the place of the first; a team member is never made a head.
  const second = await owner('POST', '/api/users', { email: 'otherhead.test@swishhh.net', name: 'Huda Otherhead', roleId: 'dept_head', departmentId: free.id });
  assert.equal(second.body.linkedHeadOf, null);
  // Unless the admin asks to make them the head: then they replace the first.
  const replaced = await owner('PATCH', `/api/users/${second.body.id}`, { makeHead: true, roleId: 'dept_head', departmentId: free.id });
  assert.equal(replaced.body.linkedHeadOf, free.name, JSON.stringify(replaced.body));
  assert.equal((await owner('GET', '/api/meta')).body.departments.find((d: any) => d.id === free.id).headUserId, second.body.id);
  const meta2 = (await owner('GET', '/api/meta')).body;
  const free2 = meta2.departments.find((d: any) => !d.headUserId);
  if (free2) {
    const plain = await owner('POST', '/api/users', { email: 'plainmember.test@swishhh.net', name: 'Pam Plain', roleId: 'member', departmentId: free2.id });
    assert.equal(plain.body.linkedHeadOf, null);
    // Made a department head later: linked then.
    const promoted = await owner('PATCH', `/api/users/${plain.body.id}`, { roleId: 'dept_head' });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.linkedHeadOf, free2.name);
  }
});

test('change requests: after the baseline, scope, cost and schedule change only through an approved request', async () => {
  const made = await owner('POST', '/api/projects', {
    name: 'Controlled project', departmentId: ids.deptA, managerId: ids.pm, memberIds: [ids.member],
    startDate: sun, endDate: addDays(sun, 59), budget: 1000,
    milestones: [{ name: 'Gate one', date: addDays(sun, 10) }, { name: 'Gate two', date: addDays(sun, 20) }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pid = made.body.project.id;
  const plan = async () => (await pm('GET', `/api/projects/${pid}`)).body;
  let p = await plan();
  const gate1 = p.tasks.find((t: any) => t.name === 'Gate one');
  const phase = p.tasks.find((t: any) => t.kind === 'summary' && !t.notRequired);

  // Before the baseline the owner plans freely.
  assert.equal((await pm('PATCH', `/api/tasks/${gate1.id}`, { endDate: addDays(sun, 11), startDate: addDays(sun, 11), changeReason: 'Planning it' })).status, 200);
  assert.equal((await pm('POST', `/api/projects/${pid}/baseline`, {})).status, 200);
  assert.ok((await plan()).project.baselineEnd, 'baselined');

  // After it, the commitments are locked: dates, budget, scope, milestones.
  const locked = async (r: Promise<any>, what: string) => {
    const x = await r;
    assert.equal(x.status, 409, what + ': ' + JSON.stringify(x.body));
    assert.match(x.body.error, /change request/);
  };
  await locked(pm('PATCH', `/api/projects/${pid}`, { endDate: addDays(sun, 70) }), 'end date');
  await locked(pm('PATCH', `/api/projects/${pid}`, { budget: 2000 }), 'budget');
  await locked(pm('PATCH', `/api/projects/${pid}`, { scope: 'Something else' }), 'scope');
  await locked(pm('PATCH', `/api/tasks/${gate1.id}`, { endDate: addDays(sun, 13), startDate: addDays(sun, 13), changeReason: 'Late supplier' }), 'milestone date');
  await locked(pm('PATCH', `/api/tasks/${gate1.id}`, { status: 'cancelled' }), 'cancel milestone');
  await locked(pm('POST', `/api/projects/${pid}/tasks`, { kind: 'milestone', name: 'Extra', startDate: addDays(sun, 30), parentId: phase.id }), 'new milestone');
  await locked(pm('DELETE', `/api/tasks/${gate1.id}`), 'delete milestone');
  // What is not a commitment still changes: the name, and the work inside a milestone.
  assert.equal((await pm('PATCH', `/api/projects/${pid}`, { name: 'Controlled project (renamed)' })).status, 200);
  assert.equal((await pm('POST', `/api/projects/${pid}/tasks`, { kind: 'task', name: 'Prepare gate one', startDate: sun, endDate: addDays(sun, 3), parentId: gate1.id })).status, 201);

  // The request (the form). A team member may ask. Nothing moves yet.
  assert.equal((await pm('PATCH', `/api/tasks/${gate1.id}`, { assigneeId: ids.member })).status, 200, 'the member has work in it');
  assert.equal((await member('POST', `/api/projects/${pid}/changes`, { description: 'x', reason: 'Because of the supplier' })).status, 400, 'a description');
  let since = mails.length;
  const cr = await member('POST', `/api/projects/${pid}/changes`, {
    description: 'Move gate one and extend the project',
    reason: 'The supplier delivers two weeks late',
    actions: 'Tell operations, update the plan',
    actionsDate: addDays(sun, 12),
    changes: {
      endDate: addDays(sun, 73),
      budget: 1500,
      milestones: [{ taskId: gate1.id, action: 'move', to: addDays(sun, 24) }],
      newMilestones: [{ name: 'Supplier check', date: addDays(sun, 18), parentId: phase.id }],
    },
  });
  assert.equal(cr.status, 201, JSON.stringify(cr.body));
  assert.equal(cr.body.code, 'CR-001');
  assert.equal(cr.body.stage, 'head');
  assert.equal(cr.body.status, 'pending');
  assert.deepEqual(cr.body.areas.sort(), ['cost', 'schedule', 'scope']);
  assert.equal(cr.body.before.endDate, addDays(sun, 59));
  assert.equal((await plan()).project.endDate, addDays(sun, 59), 'nothing changes before the approvals');
  await waitForMail('head.test@swishhh.net', since, 'asks for a change');

  // The head of the department first. Nobody else at this step, and nobody on their own request.
  const id = cr.body.id;
  assert.equal((await owner('POST', `/api/changes/${id}/decide`, { decision: 'approve' })).status, 403, 'the PMO waits for the head');
  assert.equal((await pm('POST', `/api/changes/${id}/decide`, { decision: 'approve' })).status, 403);
  assert.equal((await member('POST', `/api/changes/${id}/decide`, { decision: 'approve' })).status, 403);
  assert.equal((await head('GET', '/api/change-requests/pending')).body.filter((c: any) => c.id === id).length, 1, 'waiting for the head');
  assert.equal((await head('POST', `/api/changes/${id}/decide`, { decision: 'hold' })).body.status, 'on_hold');
  assert.equal((await head('POST', `/api/changes/${id}/decide`, { decision: 'resume' })).body.status, 'pending');
  since = mails.length;
  const headOk = await head('POST', `/api/changes/${id}/decide`, { decision: 'approve', note: 'Fine by the department' });
  assert.equal(headOk.status, 200, JSON.stringify(headOk.body));
  assert.equal(headOk.body.stage, 'pmo');
  assert.equal(headOk.body.headByName, 'Hana Head');
  assert.equal((await plan()).project.endDate, addDays(sun, 59), 'still nothing applied');
  await waitForMail('owner.test@swishhh.net', since, 'asks for a change');

  // The PMO's final approval applies it, and the new dates become the approved ones.
  assert.equal((await owner('POST', `/api/changes/${id}/decide`, { decision: 'reject' })).status, 400, 'a rejection needs its reason');
  const final = await owner('POST', `/api/changes/${id}/decide`, { decision: 'approve' });
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(final.body.status, 'approved');
  assert.ok(final.body.applied.length >= 4, JSON.stringify(final.body.applied));
  assert.equal(final.body.completionDate, todayIso());
  p = await plan();
  assert.equal(p.project.endDate, addDays(sun, 73));
  assert.equal(p.project.baselineEnd, addDays(sun, 73), 'the approved end is the baseline');
  assert.equal(Number(p.project.budget), 1500);
  const moved = p.tasks.find((t: any) => t.id === gate1.id);
  assert.equal(moved.endDate, addDays(sun, 24));
  assert.equal(moved.baselineEnd, addDays(sun, 24));
  assert.ok(p.tasks.some((t: any) => t.name === 'Supplier check' && t.kind === 'milestone' && t.parentId === phase.id));
  assert.equal((await owner('POST', `/api/changes/${id}/decide`, { decision: 'approve' })).status, 409, 'decided once');

  // The change log: everyone on the project reads it; the owner keeps its follow-up columns.
  const log = (await member('GET', `/api/projects/${pid}/changes`)).body;
  assert.equal(log.length, 1);
  assert.equal((await pm('PATCH', `/api/changes/${id}`, { progress: 'Supplier confirmed', notes: 'Watch the new date' })).body.progress, 'Supplier confirmed');
  assert.equal((await member('PATCH', `/api/changes/${id}`, { notes: 'mine' })).status, 403);

  // Asked by the head: no step of their own, straight to the PMO. A request can be withdrawn while waiting.
  const byHead = await head('POST', `/api/projects/${pid}/changes`, { description: 'Cut the budget back', reason: 'Savings found', changes: { budget: 1200 } });
  assert.equal(byHead.status, 201, JSON.stringify(byHead.body));
  assert.equal(byHead.body.stage, 'pmo');
  assert.ok(byHead.body.headSkipped);
  assert.equal((await owner('POST', `/api/changes/${byHead.body.id}/decide`, { decision: 'reject', note: 'Not now' })).body.status, 'rejected');
  assert.equal(Number((await plan()).project.budget), 1500, 'a rejected change changes nothing');
  const third = await pm('POST', `/api/projects/${pid}/changes`, { description: 'Change the scope text', reason: 'Clearer wording', changes: { scope: 'Clearer scope' } });
  assert.equal(third.body.code, 'CR-003');
  assert.equal((await member('POST', `/api/changes/${third.body.id}/withdraw`)).status, 403);
  assert.equal((await pm('POST', `/api/changes/${third.body.id}/withdraw`)).body.status, 'withdrawn');
  // The PMO removes a request that was never approved (a test, a duplicate); an approved one stays in the log.
  assert.equal((await member('DELETE', `/api/changes/${third.body.id}`)).status, 403);
  assert.equal((await pm('DELETE', `/api/changes/${third.body.id}`)).status, 403, 'the project manager is not the PMO');
  assert.equal((await owner('DELETE', `/api/changes/${id}`)).status, 409, 'an approved change stays in the log');
  assert.equal((await owner('DELETE', `/api/changes/${third.body.id}`)).status, 200);
  assert.ok(!(await pm('GET', `/api/projects/${pid}/changes`)).body.some((c: any) => c.id === third.body.id), 'gone from the log');
  assert.equal((await owner('DELETE', `/api/changes/${third.body.id}`)).status, 404);
  // A request must say what it touches.
  assert.equal((await pm('POST', `/api/projects/${pid}/changes`, { description: 'Just talk', reason: 'No reason at all' })).status, 400);
  assert.equal((await pm('POST', `/api/projects/${pid}/changes`, { description: 'A process change', reason: 'Better control', areas: ['scope'] })).status, 201);
});

test('the transformation plan: capabilities, dimensions and plan projects, with the projects linked under them', async () => {
  assert.deepEqual((await member('GET', '/api/transformation')).body, [], 'not for team members');
  const plan = (await owner('GET', '/api/transformation')).body;
  assert.equal(plan.length, 7, 'seven capabilities from the workbook');
  const dims = plan.flatMap((c: any) => c.dimensions);
  const inits = dims.flatMap((d: any) => d.initiatives);
  assert.equal(dims.length, 58);
  assert.equal(inits.length, 172);
  assert.equal(plan[0].name, 'Customer Experience Capability');
  assert.equal(plan[0].dimensions[0].name, 'Product Availability');
  const demand = inits.find((i: any) => i.name === 'Demand Planning Model Implementation');
  assert.ok(demand);

  // Only the PMO links projects to the plan; the list says what is suggested.
  assert.equal((await member('GET', '/api/transformation/links')).status, 403);
  const links = (await owner('GET', '/api/transformation/links')).body;
  assert.ok(links.length > 0 && links.every((l: any) => !('suggestion' in l)), 'no automatic suggestions');
  assert.equal((await pm('POST', '/api/transformation/links', { links: [{ projectId: ids.project, initiativeId: demand.id }] })).status, 403);
  const saved = await owner('POST', '/api/transformation/links', { links: [{ projectId: ids.project, initiativeId: demand.id }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.saved, 1);
  assert.equal((await owner('POST', '/api/transformation/links', { links: [{ projectId: ids.project, initiativeId: 99999 }] })).status, 400);

  // The plan shows it under its plan project, to those who can see the project, and the project knows its link.
  const find = (p: any[]) => p.flatMap((c: any) => c.dimensions).flatMap((d: any) => d.initiatives).find((i: any) => i.id === demand.id);
  assert.deepEqual(find((await owner('GET', '/api/transformation')).body).projectIds, [ids.project]);
  assert.deepEqual((await outsider('GET', '/api/transformation')).body, [], 'no plan for someone outside the PMO and the department heads');
  // A department head sees only the plan projects of their department (and of portfolios or programs they manage).
  const mine = (await head('GET', '/api/transformation')).body.flatMap((c: any) => c.dimensions).flatMap((d: any) => d.initiatives).map((i: any) => i.id);
  assert.deepEqual(mine, [demand.id], 'only the plan project their department delivers');
  const outside = inits.find((i: any) => i.projectIds.length === 0 && i.id !== demand.id);
  assert.equal((await head('POST', '/api/projects', { name: 'Not mine to start', departmentId: ids.deptA, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 10), initiativeId: outside.id })).status, 403, 'cannot start a plan project outside their scope');
  assert.equal((await pm('GET', `/api/projects/${ids.project}`)).body.project.initiativeId, demand.id);

  // An empty plan project starts its project from the list: created under its name and linked at once.
  const empty = inits.find((i: any) => i.projectIds.length === 0 && i.id !== demand.id);
  const started = await owner('POST', '/api/projects', { name: empty.name, initiativeId: empty.id, departmentId: ids.deptA, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 30) });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal((await owner('GET', `/api/projects/${started.body.project.id}`)).body.project.initiativeId, empty.id);
  assert.equal((await owner('POST', '/api/projects', { name: 'Nowhere', initiativeId: 99999, departmentId: ids.deptA, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 30) })).status, 400);

  // A project manager starts a plan project nobody has started yet, in any department, and runs it; the PMO hears.
  const open = (await pm('GET', '/api/transformation/open')).body;
  assert.ok(!open.some((i: any) => i.id === empty.id || i.id === demand.id), 'started plan projects are not offered');
  const free = open[0];
  assert.ok(free, 'a plan project not started yet is offered');
  const pmPlan = (await pm('GET', '/api/transformation')).body.flatMap((c: any) => c.dimensions).flatMap((d: any) => d.initiatives).map((i: any) => i.id);
  assert.ok(pmPlan.includes(free.id), 'the plan shows a project manager the plan projects not started yet');
  const pmBody = { name: free.name, initiativeId: free.id, departmentId: ids.deptA, managerId: ids.head, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 30) };
  const byPm = await pm('POST', '/api/projects', pmBody);
  assert.equal(byPm.status, 201, JSON.stringify(byPm.body));
  assert.equal(byPm.body.project.managerId, ids.pm, 'the project manager who starts it runs it');
  assert.equal(byPm.body.project.initiativeId, free.id);
  assert.equal((await pm('POST', '/api/projects', pmBody)).status, 409, 'a plan project starts once');
  assert.equal((await pm('POST', '/api/projects', { ...pmBody, initiativeId: undefined })).status, 403, 'outside the plan only heads and the PMO start projects');
  assert.deepEqual((await outsider('GET', '/api/transformation/open')).body, [], 'a team member is offered none');

  // A new version of the workbook updates the plan: new rows are added, existing ones take its values, nothing is lost.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Projects');
  ws.addRow(['Transformation Projects']);
  ws.addRow([]);
  ws.addRow(['Capability', 'Dimension', 'Project', 'Type', 'Status', 'Priority', 'Project Owner']);
  ws.addRow(['Customer Experience Capability', 'Product Availability', 'Demand Planning Model Implementation', 'Strategic', 'In Progress', 'High', 'Hassan']);
  ws.addRow(['New Capability', 'New Dimension', 'A brand new plan project']);
  const data = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  assert.equal((await pm('POST', '/api/transformation/import', { data })).status, 403);
  const imported = await owner('POST', '/api/transformation/import', { data, name: 'plan.xlsx' });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.added, 1);
  assert.equal(imported.body.notInWorkbook, 171, 'the others stay');
  const after = (await owner('GET', '/api/transformation')).body;
  const updated = find(after);
  assert.equal(updated.owner, 'Hassan');
  assert.equal(updated.priority, 'High');
  assert.deepEqual(updated.projectIds, [ids.project], 'the link survives the import');
  assert.ok(after.some((c: any) => c.name === 'New Capability'));
  assert.equal((await owner('POST', '/api/transformation/import', { data: Buffer.from('not a workbook').toString('base64') })).status, 400);

  // Clearing a link.
  assert.equal((await owner('POST', '/api/transformation/links', { links: [{ projectId: ids.project, initiativeId: null }] })).body.saved, 1);
});

test('the milestones tracker: preview, create new projects, update only status/%/comment/blocker, dates recovered from "days"', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const HEAD = ['Project ID', 'Project Name', 'Phase', 'Milestone ID', 'Milestone Description', 'Responsible Department', 'Responsible Owner', 'Escalate To', 'Original Deadline', 'Current Deadline', 'Days to Deadline', 'Status', '% Complete', 'Last Update', 'Update Comment', 'Dependency / Blocker'];
  const book = async (rows: any[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('in');
    ws.addRow(['Milestones Tracker']);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow(HEAD);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  };
  // The file was calculated on BASE: a real date and its days give it; the other months were lost ("?").
  const BASE = addDays(sun, 0);
  const lost = (n: number) => `${String(Number(addDays(BASE, n).slice(8, 10))).padStart(2, '0')}-?????-26`;
  const rows1 = [
    ['TRK1', 'Tracked project one', 'Design', 'TRK1-01', 'Draft the design', 'HR', 'Mona', 'Zed', lost(2), lost(2), 2, 'On Track', 0.5, '', 'Started', ''],
    ['TRK1', 'Tracked project one', 'Design', 'TRK1-02', 'Review the design', 'HR', 'Mona', 'Zed', lost(5), addDays(BASE, 5), 5, 'Not Started', '', '', '', ''],
    ['TRK1', 'Tracked project one', 'Rollout', 'TRK1-03', 'Launch', 'HR', 'Wael', 'Zed', lost(9), addDays(BASE, 9), 9, 'On Hold', 0, '', 'Waiting for IT', 'Server not ready'],
  ];
  const first = await book(rows1);
  assert.equal((await pm('POST', '/api/tracker/preview', { data: first })).status, 403, 'only the PMO');
  const pre = await owner('POST', '/api/tracker/preview', { data: first });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.equal(pre.body.base, BASE, 'the day the file was calculated is found from the real dates and their days');
  assert.equal(pre.body.created.length, 1);
  assert.equal(pre.body.created[0].milestones, 3);
  assert.equal(pre.body.created[0].start, addDays(BASE, 2), 'the lost months are recovered from the days');
  assert.equal(pre.body.created[0].end, addDays(BASE, 9));
  assert.equal((await owner('GET', '/api/projects')).body.some((p: any) => p.code === 'TRK1'), false, 'a preview writes nothing');

  const applied = await owner('POST', '/api/tracker/apply', { data: first, name: 'tracker.xlsx' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const proj = (await owner('GET', '/api/projects')).body.find((p: any) => p.code === 'TRK1');
  assert.ok(proj, 'the new project exists');
  const detail = (await owner('GET', `/api/projects/${proj.id}`)).body;
  const ms = detail.tasks.filter((t: any) => t.kind === 'milestone' && !t.systemKey);
  assert.equal(ms.length, 3);
  assert.deepEqual(detail.tasks.filter((t: any) => t.kind === 'summary').map((t: any) => t.name).sort(), ['Design', 'Rollout'], 'phases hold the milestones');
  assert.equal(ms.find((t: any) => t.code === 'TRK1-03').status, 'blocked', 'On Hold is blocked');
  assert.equal(ms.find((t: any) => t.code === 'TRK1-01').progress, 50);

  // A later file: only the news changes. The same file again changes nothing.
  assert.equal((await owner('POST', '/api/tracker/preview', { data: first })).body.updated.length, 0, 'applied once: nothing left to change');
  const rows2 = [
    ['TRK1', 'Tracked project one', 'Design', 'TRK1-1', 'Draft the design', 'HR', 'Mona', 'Zed', lost(2), addDays(BASE, 40), 2, 'Completed', 1, '', 'Done and signed', ''],
    rows1[1],
    rows1[2],
  ];
  const second = await owner('POST', '/api/tracker/apply', { data: await book(rows2) });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.created.length, 0);
  assert.equal(second.body.updated[0].changes.length, 1, 'TRK1-1 is TRK1-01: zeros do not matter');
  const after = (await owner('GET', `/api/projects/${proj.id}`)).body.tasks.filter((t: any) => t.kind === 'milestone');
  const one = after.find((t: any) => t.code === 'TRK1-01');
  assert.equal(one.status, 'done');
  assert.equal(one.progress, 100);
  assert.equal(one.updateComment, 'Done and signed');
  assert.equal(one.endDate, addDays(BASE, 2), 'dates are never touched by an update');
  const history = (await owner('GET', `/api/tasks/${one.id}/updates`)).body;
  assert.ok(history.length >= 1, 'the change is in the milestone history');

  // Not the tracker.
  const wrong = new ExcelJS.Workbook();
  wrong.addWorksheet('x').addRow(['nothing', 'here']);
  assert.equal((await owner('POST', '/api/tracker/preview', { data: Buffer.from(await wrong.xlsx.writeBuffer()).toString('base64') })).status, 400);
});

test('first sign-in by email: asking is limited per address', async () => {
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await client()('POST', '/api/auth/first-access', { email: `nobody${i}@swishhh.net` })).status === 429) limited++;
  assert.ok(limited >= 1, 'a flood of requests is stopped');
});

test('replies by email: system emails carry a signed Reply-To, and a reply is answered from what the person can see', async () => {
  const hook = (body: unknown, password = INBOUND_SECRET) =>
    fetch(`${BASE}/api/inbound/postmark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`postmark:${password}`).toString('base64')}` },
      body: JSON.stringify(body),
    });
  const waitForMail = async (n: number) => {
    for (let i = 0; i < 50 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 100));
  };
  const reply = (email: string, tag: string, id: string) => ({
    FromFull: { Email: email },
    MailboxHash: tag,
    MessageID: id,
    Subject: 'SWiSH PMO: your weekly update is due',
    StrippedTextReply: 'Which of my projects are late?',
    Headers: [{ Name: 'Message-ID', Value: `<${id}@mail.example.test>` }],
  });

  // Outgoing mail tells the client to reply to the inbound address, tagged for its recipient.
  const before = mails.length;
  assert.equal((await owner('POST', '/api/mail/test', {})).status, 200);
  await waitForMail(before + 1);
  assert.ok(mails[mails.length - 1].raw.includes(`abc123+${replyTag('owner.test@swishhh.net', '', INBOUND_SECRET)}@inbound.example.test`));

  // The webhook needs its password.
  assert.equal((await hook(reply('member.test@swishhh.net', replyTag('member.test@swishhh.net', '', INBOUND_SECRET), 'm0'), 'wrong')).status, 401);

  // A tag made for someone else, or no tag, gets no answer.
  let since = mails.length;
  assert.equal((await hook(reply('member.test@swishhh.net', replyTag('pm.test@swishhh.net', '', INBOUND_SECRET), 'm1'))).status, 200);
  assert.equal((await hook(reply('member.test@swishhh.net', '', 'm2'))).status, 200);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(mails.length, since);

  // A real reply: answered by email, read only, from the member's own projects, once even if posted twice.
  const { body: list } = await member('GET', '/api/projects');
  const mineId = list.find((p: any) => p.name === 'Askable Alpha').id;
  aiAnswer = { answer: 'مشروع Alpha متأخر.\nCheck it today.', projectIds: [mineId] };
  const calls = aiCalls.length;
  const ok = reply('Member.Test@swishhh.net', replyTag('member.test@swishhh.net', '', INBOUND_SECRET), 'm3');
  assert.equal((await hook(ok)).status, 200);
  await waitForMail(since + 1);
  assert.equal(mails.length, since + 1);
  const m = mails[mails.length - 1];
  assert.deepEqual(m.to, ['member.test@swishhh.net']);
  assert.ok(m.raw.includes('Re: SWiSH PMO: your weekly update is due'));
  assert.ok(m.raw.includes('In-Reply-To: <m3@mail.example.test>'));
  const sent = JSON.stringify(aiCalls[calls]);
  assert.ok(sent.includes('Which of my projects are late?') && sent.includes('Askable Alpha') && !sent.includes('Hidden Beta Programme'));
  await hook(ok);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(mails.length, since + 1, 'the same message is answered once');
});

test('changes by email: proposed back, made only on a YES to that email, as the person, once', async () => {
  const hook = (body: unknown) =>
    fetch(`${BASE}/api/inbound/postmark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`postmark:${INBOUND_SECRET}`).toString('base64')}` },
      body: JSON.stringify(body),
    });
  const next = async (n: number) => {
    for (let i = 0; i < 50 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(mails.length, n);
    return mails[n - 1].raw.replace(/=\r\n/g, '');
  };
  const mail = (email: string, ref: string, id: string, text: string) => ({
    FromFull: { Email: email },
    MailboxHash: `${ref ? `${ref}-` : ''}${replyTag(email, ref, INBOUND_SECRET)}`,
    MessageID: id,
    Subject: 'SWiSH PMO: a project',
    StrippedTextReply: text,
  });
  const none = { projectId: -1, taskId: -1, itemId: -1, startDate: '', endDate: '', progress: -1, status: '', health: '', comment: '', blocker: '', reason: '', decision: '', accomplishments: '', nextSteps: '', blockers: '', decisions: '' };
  const list = (await owner('GET', '/api/projects')).body;
  const alpha = list.find((p: any) => p.name === 'Askable Alpha');
  const newStart = addDays(alpha.startDate, -1);

  // The model proposes; the person gets the server's own sentence back, and nothing has changed yet.
  aiAnswer = { answer: 'I will move the start.', projectIds: [alpha.id], actions: [{ ...none, type: 'project_dates', projectId: alpha.id, startDate: newStart }] };
  let n = mails.length;
  await hook(mail('owner.test@swishhh.net', `p${alpha.id}`, 'c1', 'Move the start of this project one day earlier'));
  let raw = await next(n + 1);
  assert.ok(raw.includes(`Change the start date from ${alpha.startDate} to ${newStart} of the project`), raw.slice(0, 3000));
  assert.ok(raw.includes('Reply to this email to confirm'));
  const ref = /abc123\+(a\d+)-[0-9a-f]{24}@/.exec(raw)?.[1];
  assert.ok(ref, 'the confirmation names the proposal in its Reply-To');
  assert.equal((await owner('GET', `/api/projects/${alpha.id}`)).body.project.startDate, alpha.startDate);

  // Someone else cannot confirm it, even with a genuine tag of their own for that proposal.
  n = mails.length;
  await hook(mail('pm.test@swishhh.net', ref!, 'c2', 'YES'));
  raw = await next(n + 1);
  assert.ok(raw.includes('already done, or it is more than 24 hours old'));
  assert.equal((await owner('GET', `/api/projects/${alpha.id}`)).body.project.startDate, alpha.startDate);

  // The YES makes it, through the normal API.
  n = mails.length;
  await hook(mail('owner.test@swishhh.net', ref!, 'c3', 'Yes\n\nthanks'));
  raw = await next(n + 1);
  assert.ok(raw.includes('Done: Change the start date'), raw.slice(0, 3000));
  assert.equal((await owner('GET', `/api/projects/${alpha.id}`)).body.project.startDate, newStart);

  // Only once.
  n = mails.length;
  await hook(mail('owner.test@swishhh.net', ref!, 'c4', 'نعم'));
  raw = await next(n + 1);
  assert.ok(raw.includes('already done'));

  // The system's own rules still apply on a YES, and its reason comes back by email.
  aiAnswer = { answer: 'Moving it.', projectIds: [alpha.id], actions: [{ ...none, type: 'project_dates', projectId: alpha.id, endDate: addDays(alpha.endDate, 5) }] };
  n = mails.length;
  await hook(mail('member.test@swishhh.net', `p${alpha.id}`, 'c5', 'Move the end of Askable Alpha by 5 days'));
  raw = await next(n + 1);
  const mref = /abc123\+(a\d+)-[0-9a-f]{24}@/.exec(raw)?.[1];
  // Before the YES, the project is handed to someone else: the member may no longer change it.
  assert.equal((await owner('PATCH', `/api/projects/${alpha.id}`, { managerId: ids.pm })).status, 200);
  await new Promise((r) => setTimeout(r, 500)); // its own email to the new owner
  n = mails.length;
  await hook(mail('member.test@swishhh.net', mref!, 'c6', 'YES'));
  raw = await next(n + 1);
  assert.ok(raw.includes('The system did not make this change'), raw.slice(raw.indexOf('Hello'), raw.indexOf('Hello') + 600));

  // An id outside what the person was shown is never proposed: the answer comes back instead.
  aiAnswer = { answer: 'Which project?', projectIds: [], actions: [{ ...none, type: 'project_dates', projectId: 999999, startDate: newStart }] };
  n = mails.length;
  await hook(mail('owner.test@swishhh.net', '', 'c7', 'Move the start of project 999999'));
  raw = await next(n + 1);
  assert.ok(raw.includes('Which project?') && !raw.includes('Reply to this email to confirm'));
});

test('replies by email: with no project named, the model is given the person\'s own projects and the earlier thread', async () => {
  const none = { projectId: -1, taskId: -1, itemId: -1, startDate: '', endDate: '', progress: -1, status: '', health: '', comment: '', blocker: '', reason: '', decision: '', accomplishments: '', nextSteps: '', blockers: '', decisions: '' };
  aiAnswer = { answer: 'Which one?', projectIds: [], actions: [] };
  const calls = aiCalls.length;
  const n = mails.length;
  await fetch(`${BASE}/api/inbound/postmark`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`postmark:${INBOUND_SECRET}`).toString('base64')}` },
    body: JSON.stringify({
      FromFull: { Email: 'pm.test@swishhh.net' },
      MailboxHash: replyTag('pm.test@swishhh.net', '', INBOUND_SECRET),
      MessageID: 'own-1',
      Subject: 'RE: SWiSH PMO: your answer',
      StrippedTextReply: 'the one that started already',
      TextBody: 'the one that started already\n\n> Which project would you like to change?\n> You asked: move the start of my project to yesterday',
    }),
  });
  for (let i = 0; i < 50 && mails.length <= n; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(mails.length, n + 1);
  const sent = JSON.stringify(aiCalls[calls]);
  assert.ok(sent.includes('\\"focus\\":{\\"projects\\":[{') && sent.includes('Hidden Beta Programme') && sent.includes('Askable Alpha'), 'their projects, with tasks');
  assert.ok(sent.includes('move the start of my project to yesterday'), 'the earlier thread');
  assert.ok(sent.includes('\\"yourRole\\":\\"manager\\"'), 'and which ones they manage');
});

test('changes by email: several changes in one email are listed together and made with one YES', async () => {
  const none = { projectId: -1, taskId: -1, itemId: -1, startDate: '', endDate: '', progress: -1, status: '', health: '', comment: '', blocker: '', reason: '', decision: '', accomplishments: '', nextSteps: '', blockers: '', decisions: '' };
  const hook = (email: string, ref: string, id: string, text: string) =>
    fetch(`${BASE}/api/inbound/postmark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`postmark:${INBOUND_SECRET}`).toString('base64')}` },
      body: JSON.stringify({ FromFull: { Email: email }, MailboxHash: `${ref ? `${ref}-` : ''}${replyTag(email, ref, INBOUND_SECRET)}`, MessageID: id, Subject: 'x', StrippedTextReply: text }),
    });
  const next = async (n: number) => {
    for (let i = 0; i < 50 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(mails.length, n);
    return mails[n - 1].raw.replace(/=\r\n/g, '');
  };
  const alpha = (await owner('GET', '/api/projects')).body.find((p: any) => p.name === 'Askable Alpha');
  const start = addDays(alpha.startDate, -2);
  const end = addDays(alpha.endDate, 3);
  aiAnswer = { answer: '', projectIds: [alpha.id], actions: [{ ...none, type: 'project_dates', projectId: alpha.id, startDate: start }, { ...none, type: 'project_dates', projectId: alpha.id, endDate: end }] };
  let n = mails.length;
  await hook('owner.test@swishhh.net', `p${alpha.id}`, 'multi-1', 'Start two days earlier and end three days later');
  let raw = await next(n + 1);
  assert.ok(raw.includes('1. Change the start date') && raw.includes('2. Change the end date') && raw.includes('approve all of them'), raw.slice(raw.indexOf('Hello'), raw.indexOf('Hello') + 600));
  const ref = /abc123\+(a\d+)-[0-9a-f]{24}@/.exec(raw)?.[1];
  n = mails.length;
  await hook('owner.test@swishhh.net', ref!, 'multi-2', 'ok proceed');
  raw = await next(n + 1);
  assert.ok(raw.includes('Done:'));
  const p = (await owner('GET', `/api/projects/${alpha.id}`)).body.project;
  assert.equal(p.startDate, start);
  assert.equal(p.endDate, end);
});

test('changes by email: any words that agree confirm, a no cancels, and the model reads the unusual ones', async () => {
  const none = { projectId: -1, taskId: -1, itemId: -1, startDate: '', endDate: '', progress: -1, status: '', health: '', comment: '', blocker: '', reason: '', decision: '', accomplishments: '', nextSteps: '', blockers: '', decisions: '' };
  const hook = (ref: string, id: string, text: string) =>
    fetch(`${BASE}/api/inbound/postmark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`postmark:${INBOUND_SECRET}`).toString('base64')}` },
      body: JSON.stringify({ FromFull: { Email: 'owner.test@swishhh.net' }, MailboxHash: `${ref ? `${ref}-` : ''}${replyTag('owner.test@swishhh.net', ref, INBOUND_SECRET)}`, MessageID: id, Subject: 'x', StrippedTextReply: text }),
    });
  const next = async (n: number) => {
    for (let i = 0; i < 50 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(mails.length, n);
    return mails[n - 1].raw.replace(/=\r\n/g, '');
  };
  const alpha = (await owner('GET', '/api/projects')).body.find((p: any) => p.name === 'Askable Alpha');
  const propose = async (id: string, start: string) => {
    aiAnswer = { answer: '', projectIds: [alpha.id], actions: [{ ...none, type: 'project_dates', projectId: alpha.id, startDate: start }] };
    const n = mails.length;
    await hook(`p${alpha.id}`, id, 'move the start');
    return /abc123\+(a\d+)-[0-9a-f]{24}@/.exec(await next(n + 1))![1];
  };

  // "no thanks" cancels; nothing changes, and a later yes to the same email does nothing.
  const first = await propose('w1', addDays(alpha.startDate, -5));
  let n = mails.length;
  await hook(first, 'w2', 'No thanks, leave it');
  assert.ok((await next(n + 1)).includes('Cancelled. Nothing was changed.'));
  n = mails.length;
  await hook(first, 'w3', 'yes');
  assert.ok((await next(n + 1)).includes('already done'));
  assert.equal((await owner('GET', `/api/projects/${alpha.id}`)).body.project.startDate, alpha.startDate);

  // Unusual wording is read by the model; agreeing makes the change.
  const want = addDays(alpha.startDate, -6);
  const second = await propose('w4', want);
  aiAnswer = { intent: 'agree' };
  n = mails.length;
  await hook(second, 'w5', 'Sounds good to me, carry on');
  assert.ok((await next(n + 1)).includes('Done:'));
  assert.equal((await owner('GET', `/api/projects/${alpha.id}`)).body.project.startDate, want);
});

test('a project end date can never be before its start, whichever of the two is changed', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const r = await owner('POST', '/api/projects', { name: 'Date Guard', departmentId: meta.departments[0].id, startDate: sun, endDate: addDays(sun, 30) });
  assert.equal(r.status, 201);
  const id = r.body.project.id;
  const end = await owner('PATCH', `/api/projects/${id}`, { endDate: addDays(sun, -1) });
  assert.equal(end.status, 400);
  assert.match(end.body.error, /end date is before the start/);
  assert.equal((await owner('PATCH', `/api/projects/${id}`, { startDate: addDays(sun, 31) })).status, 400);
  assert.equal((await owner('PATCH', `/api/projects/${id}`, { startDate: addDays(sun, 40), endDate: addDays(sun, 35) })).status, 400);
  assert.equal((await owner('PATCH', `/api/projects/${id}`, { startDate: addDays(sun, 30) })).status, 200, 'the same day is fine');
  const p = (await owner('GET', `/api/projects/${id}`)).body.project;
  assert.equal(p.startDate, addDays(sun, 30));
  assert.equal(p.endDate, addDays(sun, 30));
});

test('daily follow-up: the owner of a late milestone is asked once, the PMO can preview, and the next day waits', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const p = await owner('POST', '/api/projects', { name: 'Followed Project', departmentId: meta.departments[0].id, managerId: ids.pm, startDate: addDays(todayIso(), -40), endDate: addDays(todayIso(), 40) });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const pid = p.body.project.id;
  const m = await owner('POST', `/api/projects/${pid}/tasks`, { kind: 'milestone', name: 'Late Vendor Contract', startDate: addDays(todayIso(), -3), assigneeId: ids.member });
  assert.equal(m.status, 201, JSON.stringify(m.body));

  assert.equal((await member('POST', '/api/followups/run', { dryRun: true })).status, 403);
  const dry = await owner('POST', '/api/followups/run', { dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.mode, 'live');
  const omar = dry.body.recipients.find((r: any) => r.name === 'Omar Member');
  assert.ok(omar && omar.overdue >= 1, JSON.stringify(dry.body));

  let n = mails.length;
  assert.equal((await owner('POST', '/api/followups/run', {})).status, 200);
  for (let i = 0; i < 30 && !mails.slice(n).some((x) => x.to.includes('member.test@swishhh.net')); i++) await new Promise((r) => setTimeout(r, 100));
  const sent = mails.slice(n).find((x) => x.to.includes('member.test@swishhh.net'));
  assert.ok(sent, 'the owner is emailed');
  const raw = sent!.raw.replace(/=\r\n/g, '');
  assert.ok(raw.includes('Late Vendor Contract') && raw.includes('3 days overdue') && raw.includes('Reply to this email'));
  assert.ok(/abc123\+p\d+-[0-9a-f]{24}@/.test(raw), 'a reply comes back to the email assistant, about that project');

  // Asked today: not again until FOLLOWUP_EVERY_DAYS have passed.
  n = mails.length;
  const again = await owner('POST', '/api/followups/run', { dryRun: true });
  assert.ok(!again.body.recipients.some((r: any) => r.name === 'Omar Member'));
});

test('escalation: two unanswered follow-ups climb one level, to the project manager, then the department head, recorded on the milestone', async () => {
  const task = (await member('GET', '/api/my-work')).body;
  const list = (await owner('GET', '/api/projects')).body;
  const pid = list.find((p: any) => p.name === 'Followed Project').id;
  const detail = (await owner('GET', `/api/projects/${pid}`)).body;
  const ms = detail.tasks.find((t: any) => t.name === 'Late Vendor Contract');
  assert.ok(ms && task);
  const run = (days: number) => owner('POST', '/api/followups/run', { today: addDays(todayIso(), days) });
  const mailTo = async (to: string, n: number, text: string) => {
    for (let i = 0; i < 40 && !mails.slice(n).some((x) => x.to.includes(to) && x.raw.replace(/=\r\n/g, '').includes(text)); i++) await new Promise((r) => setTimeout(r, 100));
    return mails.slice(n).find((x) => x.to.includes(to) && x.raw.replace(/=\r\n/g, '').includes(text));
  };

  // Day +2: the second follow-up. Nothing to escalate yet (one unanswered so far counts from the first).
  let n = mails.length;
  let r = await run(2);
  assert.equal(r.body.escalations.length, 0, JSON.stringify(r.body));
  assert.ok(await mailTo('member.test@swishhh.net', n, '2nd reminder'));

  // Day +4: two unanswered: level 1 goes to the project manager, and the owner is still asked.
  n = mails.length;
  r = await run(4);
  assert.ok(r.body.escalations.some((e: any) => e.name === 'Nora Manager'), JSON.stringify(r.body.escalations));
  const esc1 = await mailTo('pm.test@swishhh.net', n, 'Escalation: your decision is needed');
  assert.ok(esc1, 'the manager gets the escalation');
  const raw = esc1!.raw.replace(/=\r\n/g, '');
  assert.ok(raw.includes('Late Vendor Contract') && raw.includes('Level 1') && raw.includes('Omar Member was asked 2 times'));
  let escs = (await owner('GET', `/api/tasks/${ms.id}/escalations`)).body;
  assert.equal(escs.length, 1);
  assert.equal(escs[0].level, 1);
  assert.equal(escs[0].toName, 'Nora Manager');

  // Day +6: one follow-up since that escalation is not enough. Day +8: two more without an answer: level 2, to the
  // next person up the line (the head of the department, else the PMO), never the manager again.
  await run(6);
  assert.equal((await owner('GET', `/api/tasks/${ms.id}/escalations`)).body.length, 1);
  n = mails.length;
  await run(8);
  for (let i = 0; i < 40 && !mails.slice(n).some((x) => /Late Vendor Contract[\s\S]{0,400}Level 2/.test(x.raw.replace(/=\r\n/g, ''))); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(mails.slice(n).some((x) => /Late Vendor Contract[\s\S]{0,400}Level 2/.test(x.raw.replace(/=\r\n/g, ''))), 'the next level is emailed');
  escs = (await owner('GET', `/api/tasks/${ms.id}/escalations`)).body;
  assert.deepEqual(escs.map((e: any) => e.level).sort(), [1, 2]);
  const l2 = escs.find((e: any) => e.level === 2);
  assert.notEqual(l2.toName, 'Nora Manager');
  assert.notEqual(l2.toName, 'Omar Member');
  assert.match(l2.note, /PMO assistant: Omar Member was asked 2 times/);

  // Nobody else may move the clock or run it.
  assert.equal((await pm('POST', '/api/followups/run', { today: addDays(todayIso(), 10) })).status, 403);
});

test('recommendations: the AI proposes, the server keeps only what checks out, and the manager approves some by number', async () => {
  const list = (await owner('GET', '/api/projects')).body;
  const proj = list.find((p: any) => p.name === 'Followed Project');
  const detail = (await owner('GET', `/api/projects/${proj.id}`)).body;
  const ms = detail.tasks.find((t: any) => t.name === 'Late Vendor Contract');
  const blank = { projectId: -1, taskId: -1, assigneeId: -1, priority: '', startDate: '', endDate: '', status: '', reason: '' };
  const newDue = addDays(todayIso(), 20);
  aiAnswer = {
    summary: 'The vendor contract is late.',
    recommendations: [
      { ...blank, type: 'task_update', taskId: ms.id, endDate: newDue, reason: 'The vendor needs three more weeks', why: 'It is 3 days late and its owner has not answered.' },
      { ...blank, type: 'project_priority', projectId: proj.id, priority: 'critical', why: 'Its only milestone is late.' },
      { ...blank, type: 'task_reassign', taskId: ms.id, assigneeId: 999999, why: 'Someone who does not exist.' },
      { ...blank, type: 'task_update', taskId: ms.id, endDate: addDays(todayIso(), -1), reason: 'In the past', why: 'A date in the past is never proposed.' },
    ],
  };
  assert.equal((await member('POST', '/api/recommendations/run', {})).status, 403);
  const n = mails.length;
  const r = await owner('POST', '/api/recommendations/run', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mine = r.body.projects.find((p: any) => p.code === proj.code);
  assert.deepEqual(mine, { code: proj.code, to: 'Nora Manager', recommendations: 2 });
  for (let i = 0; i < 40 && !mails.slice(n).some((x) => x.to.includes('pm.test@swishhh.net') && x.raw.includes('recommendations for')); i++) await new Promise((r2) => setTimeout(r2, 100));
  const mail = mails.slice(n).find((x) => x.to.includes('pm.test@swishhh.net') && x.raw.includes('recommendations for'));
  assert.ok(mail, 'the manager gets them');
  const raw = mail!.raw.replace(/=\r\n/g, '');
  assert.ok(raw.includes(`2 recommendations for ${proj.code} Followed Project`) && raw.includes('Why:') && raw.includes('The vendor contract is late.'));
  assert.ok(!raw.includes('999999') && !raw.includes('In the past'));
  const ref = /abc123\+(a\d+)-[0-9a-f]{24}@/.exec(raw)?.[1];
  assert.ok(ref);

  // "2" approves only the second: the priority changes, the deadline does not.
  const m = mails.length;
  await fetch(`${BASE}/api/inbound/postmark`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`postmark:${INBOUND_SECRET}`).toString('base64')}` },
    body: JSON.stringify({ FromFull: { Email: 'pm.test@swishhh.net' }, MailboxHash: `${ref}-${replyTag('pm.test@swishhh.net', ref!, INBOUND_SECRET)}`, MessageID: 'reco-1', Subject: 'x', StrippedTextReply: 'approve 2 only' }),
  });
  for (let i = 0; i < 40 && mails.length <= m; i++) await new Promise((r2) => setTimeout(r2, 100));
  assert.ok(mails[mails.length - 1].raw.replace(/=\r\n/g, '').includes('2. Set the priority'));
  const after = (await owner('GET', `/api/projects/${proj.id}`)).body;
  assert.equal(after.project.priority, 'critical');
  assert.equal(after.tasks.find((t: any) => t.id === ms.id).endDate, ms.endDate);

  // Asked this week: not again for seven days.
  const again = await owner('POST', '/api/recommendations/run', { dryRun: true });
  assert.ok(!again.body.projects.some((p: any) => p.code === proj.code));
});

test('a project is deleted only by a PMO admin, with a reason kept in the log; progress comes from the plan', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const p = await owner('POST', '/api/projects', { name: 'To Be Deleted', departmentId: meta.departments[0].id, managerId: ids.pm, startDate: addDays(sun, 1), endDate: addDays(sun, 30) });
  const pid = p.body.project.id;

  // A milestone with tasks under it takes its % from them.
  const ms = await owner('POST', `/api/projects/${pid}/tasks`, { kind: 'milestone', name: 'Rollout ready', startDate: addDays(sun, 20) });
  const msId = ms.body.tasks.find((t: any) => t.name === 'Rollout ready').id;
  const t1 = await owner('POST', `/api/projects/${pid}/tasks`, { kind: 'task', name: 'Prepare A', startDate: addDays(sun, 2), endDate: addDays(sun, 5), parentId: msId });
  assert.equal(t1.status, 201, JSON.stringify(t1.body));
  const a = t1.body.tasks.find((t: any) => t.name === 'Prepare A').id;
  await owner('POST', `/api/projects/${pid}/tasks`, { kind: 'task', name: 'Prepare B', startDate: addDays(sun, 2), endDate: addDays(sun, 5), parentId: msId });
  const plan = (await owner('PATCH', `/api/tasks/${a}`, { progress: 100, status: 'done' })).body;
  assert.equal(plan.tasks.find((t: any) => t.id === msId).progress, 50, 'half its tasks done');

  // The weekly update's % is the plan's, whatever is sent.
  const up = await pm('PUT', `/api/projects/${pid}/updates/${todayIso()}`, { health: 'on_track', progress: 99 });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const detail = (await pm('GET', `/api/projects/${pid}`)).body;
  assert.equal(detail.updates[0].progress, detail.project.progress);
  assert.notEqual(detail.updates[0].progress, 99);

  // Delete: not the manager, not without a reason; the PMO admin with one. It is gone, and the log keeps why.
  assert.equal((await pm('POST', `/api/projects/${pid}/delete`, { reason: 'No longer needed' })).status, 403);
  assert.equal((await owner('POST', `/api/projects/${pid}/delete`, { reason: 'x' })).status, 400);
  assert.equal((await owner('POST', `/api/projects/${pid}/delete`, { reason: 'Created twice by mistake' })).status, 200);
  assert.equal((await owner('GET', `/api/projects/${pid}`)).status, 404);
  const log = (await owner('GET', '/api/audit')).body.rows;
  assert.ok(log.some((r: any) => r.action === 'project.deleted' && JSON.stringify(r).includes('Created twice by mistake')), JSON.stringify(log.slice(0, 3)));
});

test('the weekly meeting: every part of a project is there, notes need no update, actions come back until done', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const p = await owner('POST', '/api/projects', { name: 'Meeting Project', departmentId: meta.departments[0].id, managerId: ids.pm, sponsor: 'Test Owner', startDate: addDays(todayIso(), -20), endDate: addDays(todayIso(), 40) });
  const pid = p.body.project.id;
  const week = weekStart(todayIso());
  let b = (await owner('GET', `/api/projects/${pid}/meeting?week=${week}`)).body;
  assert.equal(b.update, null, 'no update filed');
  for (const k of ['blockers', 'comments', 'overdue', 'dueThisWeek', 'escalations', 'decisions', 'notes', 'openActions']) assert.ok(Array.isArray(b[k]), k);
  assert.equal(b.canNote, true);
  assert.equal((await outsider('GET', `/api/projects/${pid}/meeting?week=${week}`)).status, 404);

  // The PMO notes an action with an owner and a due date, with no update filed.
  const n = await owner('POST', `/api/projects/${pid}/meeting-notes`, { week, kind: 'action', body: 'Send the revised plan', ownerId: ids.pm, dueDate: addDays(week, 3) });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  assert.equal(n.body.ownerName, 'Nora Manager');
  assert.equal((await outsider('POST', `/api/projects/${pid}/meeting-notes`, { week, body: 'x' })).status, 403);

  // Next week it is still open; once done it stops coming back.
  b = (await owner('GET', `/api/projects/${pid}/meeting?week=${addDays(week, 7)}`)).body;
  assert.deepEqual(b.openActions.map((a: any) => a.body), ['Send the revised plan']);
  assert.equal((await pm('PATCH', `/api/notes/${n.body.id}`, { done: true })).status, 200);
  b = (await owner('GET', `/api/projects/${pid}/meeting?week=${addDays(week, 7)}`)).body;
  assert.equal(b.openActions.length, 0);
  // A blocker on the whole project, raised in the meeting: open in later weeks until cleared, and not a note.
  const bl = await owner('POST', `/api/projects/${pid}/meeting-notes`, { week, kind: 'blocker', body: 'Vendor contract not signed' });
  assert.equal(bl.status, 201, JSON.stringify(bl.body));
  b = (await owner('GET', `/api/projects/${pid}/meeting?week=${addDays(week, 7)}`)).body;
  assert.deepEqual(b.projectBlockers.map((x: any) => x.body), ['Vendor contract not signed']);
  assert.ok(Array.isArray(b.openTasks));
  b = (await owner('GET', `/api/projects/${pid}/meeting?week=${week}`)).body;
  assert.ok(!b.notes.some((x: any) => x.kind === 'blocker'));
  assert.equal((await owner('PATCH', `/api/notes/${bl.body.id}`, { done: true })).status, 200);
  b = (await owner('GET', `/api/projects/${pid}/meeting?week=${week}`)).body;
  assert.equal(b.projectBlockers.length, 0);
  // The project keeps every meeting note, with who wrote it and when.
  const pd = (await owner('GET', `/api/projects/${pid}`)).body;
  assert.ok(pd.meetingNotes.length > 0 && pd.meetingNotes.every((n: any) => n.createdAt && n.week && 'authorName' in n), JSON.stringify(pd.meetingNotes));
  // A decision the meeting asks for: who decides is required; it waits every week until decided.
  assert.equal((await owner('POST', `/api/projects/${pid}/meeting-notes`, { week, kind: 'decision_needed', body: 'Approve the budget' })).status, 400);
  const ask = await owner('POST', `/api/projects/${pid}/meeting-notes`, { week, kind: 'decision_needed', body: 'Approve the budget', ownerId: ids.pm, dueDate: addDays(week, 5) });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  b = (await owner('GET', `/api/projects/${pid}/meeting?week=${addDays(week, 7)}`)).body;
  assert.ok(b.decisions.some((d: any) => d.kind === 'ask' && d.text === 'Approve the budget' && d.owner === 'Nora Manager'), JSON.stringify(b.decisions));
  assert.equal((await owner('PATCH', `/api/notes/${ask.body.id}`, { done: true })).status, 200);
  b = (await owner('GET', `/api/projects/${pid}/meeting?week=${addDays(week, 7)}`)).body;
  assert.ok(!b.decisions.some((d: any) => d.kind === 'ask'));

});

// ---- View as ---------------------------------------------------------------------------------------------

test('a PMO admin views the app as someone else: their view, and nothing saved', async () => {
  assert.equal((await member('POST', '/api/view-as', { userId: ids.pm })).status, 403, 'only the PMO');
  assert.equal((await owner('POST', '/api/view-as', { userId: ids.member })).status, 200);
  const meta = (await owner('GET', '/api/meta')).body;
  assert.equal(meta.me.id, ids.member, 'the app is the member\'s');
  assert.ok(meta.viewingAs, 'and says who is looking');
  assert.ok(!meta.permissions.includes('projects.edit_all'), 'with the member\'s rights only');
  const tried = await owner('PATCH', `/api/projects/${ids.project}`, { name: 'Changed while viewing' });
  assert.equal(tried.status, 423, 'nothing is saved');
  assert.match(tried.body.error, /Test mode/);
  assert.notEqual((await owner('GET', `/api/projects/${ids.project}`)).body.project?.name, 'Changed while viewing');
  assert.equal((await owner('POST', '/api/view-as/exit')).status, 200);
  const back = (await owner('GET', '/api/meta')).body;
  assert.notEqual(back.me.id, ids.member);
  assert.ok(!back.viewingAs);
});

test('a team member does not get the budget, resources, business case or risk plan of a project', async () => {
  const P = ids.project;
  const set = await owner('PATCH', `/api/projects/${P}`, { budget: 12345, resources: 'Two analysts', businessCase: 'Saves 5%', riskPlan: 'Weekly review' });
  assert.ok([200, 400].includes(set.status), JSON.stringify(set.body));
  const full = (await owner('GET', `/api/projects/${P}`)).body.project;
  const seen = await member('GET', `/api/projects/${P}`);
  assert.equal(seen.status, 200, 'the member still sees the project');
  for (const k of ['budget', 'resources', 'businessCase', 'riskPlan']) assert.equal(seen.body.project[k], null, `${k} is hidden`);
  assert.equal(seen.body.project.name, full.name, 'the rest is there');
  const inList = (await member('GET', '/api/projects?quarter=')).body.find((p: any) => p.id === P);
  if (inList) assert.equal(inList.budget, null, 'not in the list either');
  assert.equal((await member('GET', `/api/projects/${P}/export.xlsx`)).status, 403, 'nor in the project export');
  // The portfolio export holds only the projects the person runs (this member runs one elsewhere in the tests).
  assert.notEqual((await member('GET', '/api/export/portfolio.xlsx?quarter=all')).status, 500);
  assert.equal((await owner('GET', `/api/projects/${P}`)).body.project.budget, full.budget, 'the PMO still sees it');
});

test('a team member reports on their milestone but does not change its details', async () => {
  const P = ids.project;
  const d = (await owner('GET', `/api/projects/${P}`)).body;
  const ms = d.tasks.find((t: any) => t.kind === 'milestone' && !t.systemKey && t.status !== 'done' && t.status !== 'cancelled');
  assert.ok(ms, 'a milestone to work on');
  assert.equal((await owner('PATCH', `/api/tasks/${ms.id}`, { assigneeId: ids.member })).status, 200);
  assert.equal((await member('PATCH', `/api/tasks/${ms.id}`, { notes: 'my notes' })).status, 403, 'not the notes');
  assert.equal((await member('PATCH', `/api/tasks/${ms.id}`, { responsibleDept: 'Elsewhere' })).status, 403, 'not the department');
  assert.equal((await member('PATCH', `/api/tasks/${ms.id}`, { escalateTo: 'Someone' })).status, 403, 'not who to escalate to');
  const r = await member('PATCH', `/api/tasks/${ms.id}`, { status: 'in_progress', progress: 30, blocker: 'Waiting for data', updateComment: 'Started' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('an escalation nobody answers climbs the ladder by itself, one level per wait, and stops at the executives', async () => {
  // A fresh open project (the main test project is closed by now).
  const mk = await owner('POST', '/api/projects', { name: 'Climb project', departmentId: ids.deptA, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 30), milestones: [{ name: 'Climb test', date: addDays(sun, 5) }] });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const ms = mk.body.tasks.find((t: any) => t.name === 'Climb test');
  assert.ok(ms);
  await owner('PATCH', `/api/tasks/${ms.id}`, { assigneeId: ids.member });
  // The project sits in a program with a manager; the CEO step is named, IBE is not.
  const plan = (await owner('GET', '/api/transformation')).body;
  const dim = plan[1].dimensions[0];
  assert.equal((await owner('POST', '/api/transformation/links', { links: [{ projectId: mk.body.project.id, initiativeId: dim.initiatives[0].id }] })).status, 200);
  assert.equal((await pm('PUT', '/api/transformation/manager', { kind: 'dimension', id: dim.id, userId: ids.head })).status, 403, 'the PMO names managers');
  assert.equal((await owner('PUT', '/api/transformation/manager', { kind: 'dimension', id: dim.id, userId: ids.head })).status, 200);
  assert.equal((await owner('PUT', '/api/ladder-roles', { ibe: null, ceo: ids.cowner })).status, 200);
  assert.equal((await head('GET', `/api/projects/${mk.body.project.id}`)).status, 200, 'the program manager sees the project');
  assert.equal((await pm('POST', `/api/tasks/${ms.id}/escalations`, { note: 'Blocked by data access' })).status, 201);
  assert.equal((await member('POST', '/api/escalations/climb', {})).status, 403, 'only the PMO runs it by hand');
  const later = addDays(todayIso(), 30);
  const levels = async () => (await owner('GET', `/api/tasks/${ms.id}/escalations`)).body.filter((e: any) => !e.resolvedAt).map((e: any) => e.level).sort();
  await owner('POST', '/api/escalations/climb', { today: later });
  assert.deepEqual(await levels(), [1, 2], 'to the program manager');
  await owner('POST', '/api/escalations/climb', { today: later });
  assert.deepEqual(await levels(), [1, 2, 4], 'no portfolio manager: on to the PMO');
  await owner('POST', '/api/escalations/climb', { today: later });
  assert.deepEqual(await levels(), [1, 2, 4, 6], 'no IBE named: on to the CEO');
  await owner('POST', '/api/escalations/climb', { today: later });
  assert.deepEqual(await levels(), [1, 2, 4, 6], 'and no further');
  const auto = (await owner('GET', `/api/tasks/${ms.id}/escalations`)).body.find((e: any) => e.level === 2);
  assert.match(auto.note, /Raised automatically/);
});

test('an account can be made now and its setup email sent later, one by one or to everyone at once', async () => {
  const email = `held.${Date.now()}@swishhh.net`;
  const made = await owner('POST', '/api/users', { email, name: 'Held Person', roleId: 'member', sendEmail: false });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.held, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mailsTo(email).length, 0, 'nothing sent yet');
  const listed = (await owner('GET', '/api/meta')).body.users.find((u: any) => u.email === email);
  assert.equal(listed.setupEmailed, false, 'shown as not sent');
  assert.equal((await member('POST', '/api/users/send-setup-emails')).status, 403);
  const all = await owner('POST', '/api/users/send-setup-emails');
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.ok(all.body.sent >= 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(mailsTo(email).length >= 1, 'the setup email went out');
  assert.equal((await owner('GET', '/api/meta')).body.users.find((u: any) => u.email === email).setupEmailed, true);
});

test('"Needs your action" lists an escalation for the person it reached, and nobody else', async () => {
  const mk = await owner('POST', '/api/projects', { name: 'Action project', departmentId: ids.deptA, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 30), milestones: [{ name: 'Needs a hand', date: addDays(sun, 5) }] });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const ms = mk.body.tasks.find((t: any) => t.name === 'Needs a hand');
  assert.equal((await owner('POST', `/api/tasks/${ms.id}/escalations`, { note: 'Blocked' })).status, 201);
  const mine = (await pm('GET', '/api/my-actions')).body;
  assert.ok(mine.some((a: any) => a.kind === 'escalation' && a.taskId === ms.id && a.level === 1), 'the project manager is asked to act');
  const theirs = (await member('GET', '/api/my-actions')).body;
  assert.ok(!theirs.some((a: any) => a.kind === 'escalation' && a.taskId === ms.id), 'not someone else');
});

test('the weekly stand-up list is for project managers and the PMO, not team members', async () => {
  const week = weekStart(todayIso());
  assert.equal((await owner('GET', `/api/updates?week=${week}`)).status, 200);
  assert.equal((await pm('GET', `/api/updates?week=${week}`)).status, 200);
  assert.equal((await member('GET', `/api/updates?week=${week}`)).status, 403);
});

test('a team member finds only their own milestones in search, and is reminded of their milestones due soon', async () => {
  const mk = await owner('POST', '/api/projects', { name: 'Search project', departmentId: ids.deptA, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 30), milestones: [{ name: 'Zebra mine', date: addDays(sun, 5) }, { name: 'Zebra theirs', date: addDays(sun, 6) }] });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const mine = mk.body.tasks.find((t: any) => t.name === 'Zebra mine');
  assert.equal((await owner('PATCH', `/api/tasks/${mine.id}`, { assigneeId: ids.member })).status, 200);
  const found = (await member('GET', '/api/search?q=zebra')).body.milestones.map((m: any) => m.name);
  assert.deepEqual(found, ['Zebra mine'], 'only their own');
  assert.equal((await owner('GET', '/api/search?q=zebra')).body.milestones.length, 2, 'the PMO finds both');
  // Due soon: move it to today and it shows in "Needs your action".
  assert.equal((await owner('PATCH', `/api/tasks/${mine.id}`, { startDate: todayIso(), endDate: todayIso(), changeReason: 'Brought forward' })).status, 200);
  const acts = (await member('GET', '/api/my-actions')).body;
  assert.ok(acts.some((a: any) => a.kind === 'due' && a.taskId === mine.id), 'reminded');
});

test('a project manager is asked to approve a plan that has no baseline yet, and to give owners to milestones nobody owns', async () => {
  const mk = await owner('POST', '/api/projects', { name: 'Fresh plan', departmentId: ids.deptA, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 30), milestones: [{ name: 'Owned one', date: addDays(sun, 5) }, { name: 'Nobody yet', date: addDays(sun, 6) }] });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const owned = mk.body.tasks.find((t: any) => t.name === 'Owned one');
  assert.equal((await owner('PATCH', `/api/tasks/${owned.id}`, { assigneeId: ids.member })).status, 200);
  const acts = (await pm('GET', '/api/my-actions')).body.filter((a: any) => a.projectId === mk.body.project.id);
  const base = acts.find((a: any) => a.kind === 'baseline');
  assert.ok(base && base.first === true, 'never baselined: asked to approve the dates');
  const unowned = acts.find((a: any) => a.kind === 'no_owner');
  assert.ok(unowned && unowned.count >= 1, 'milestones without an owner');
  assert.ok(!(await member('GET', '/api/my-actions')).body.some((a: any) => a.projectId === mk.body.project.id && (a.kind === 'baseline' || a.kind === 'no_owner')), 'not for team members');
});

test('work across departments: asked of the other department, decided by its head (or a system admin for someone new)', async () => {
  const other = await owner('POST', '/api/users', { email: `cross.${Date.now()}@swishhh.net`, name: 'Cross Person', roleId: 'member', departmentId: ids.deptA, sendEmail: false });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const mk = await owner('POST', '/api/projects', {
    name: 'Cross project', departmentId: ids.deptB, managerId: ids.pm, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 30),
    milestones: [{ name: 'Ask person', date: addDays(sun, 5) }, { name: 'Ask dept', date: addDays(sun, 6) }, { name: 'Ask new', date: addDays(sun, 7) }],
  });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const ms = (n: string) => mk.body.tasks.find((t: any) => t.name === n).id;
  // Directly: refused. Asked: waits for the head of that department.
  assert.equal((await pm('PATCH', `/api/tasks/${ms('Ask person')}`, { assigneeId: other.body.id })).status, 400);
  const ask = await pm('POST', `/api/tasks/${ms('Ask person')}/owner-request`, { userId: other.body.id });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  assert.equal(ask.body.kind, 'person');
  assert.ok((await head('GET', '/api/owner-requests/inbox')).body.some((r: any) => r.id === ask.body.id), 'the head of that department decides');
  assert.ok((await head('GET', '/api/my-actions')).body.some((a: any) => a.kind === 'owner_request'), 'and is told');
  assert.equal((await pm('POST', `/api/owner-requests/${ask.body.id}/decide`, { decision: 'approve' })).status, 403, 'not the asker');
  assert.equal((await head('POST', `/api/owner-requests/${ask.body.id}/decide`, { decision: 'approve' })).status, 200);
  const plan = async () => (await owner('GET', `/api/projects/${mk.body.project.id}`)).body.tasks;
  assert.equal((await plan()).find((t: any) => t.id === ms('Ask person')).assigneeId, other.body.id, 'given once approved');
  // A department: its head picks the person.
  const dep = await pm('POST', `/api/tasks/${ms('Ask dept')}/owner-request`, { departmentId: ids.deptA });
  assert.equal(dep.body.kind, 'department');
  assert.equal((await head('POST', `/api/owner-requests/${dep.body.id}/decide`, { decision: 'approve' })).status, 400, 'a person must be picked');
  assert.equal((await head('POST', `/api/owner-requests/${dep.body.id}/decide`, { decision: 'approve', userId: other.body.id })).status, 200);
  // Someone new: a system admin creates the account, the milestone is theirs.
  const email = `newbie.${Date.now()}@swishhh.net`;
  const nw = await pm('POST', `/api/tasks/${ms('Ask new')}/owner-request`, { newName: 'New Bie', newEmail: email, departmentId: ids.deptA });
  assert.equal(nw.body.kind, 'new');
  assert.ok(!(await head('GET', '/api/owner-requests/inbox')).body.some((r: any) => r.id === nw.body.id), 'not for the head');
  assert.equal((await owner('POST', `/api/owner-requests/${nw.body.id}/decide`, { decision: 'approve' })).status, 200);
  const made = (await owner('GET', '/api/meta')).body.users.find((u: any) => u.email === email);
  assert.ok(made && made.setupEmailed === false, 'account made, setup email held');
  assert.equal((await plan()).find((t: any) => t.id === ms('Ask new')).assigneeId, made.id);
  // Anyone may join the team (no work is given by joining).
  const team = await pm('PUT', `/api/projects/${mk.body.project.id}/members`, { members: [{ userId: ids.pm, role: 'Project manager' }, { userId: other.body.id, role: 'Member' }] });
  assert.equal(team.status, 200, JSON.stringify(team.body));
});

test('the staff directory: kept by system admins, read by the PMO, linked to accounts by email, no loops', async () => {
  const boss = await owner('POST', '/api/staff', { name: 'Org Boss', email: 'org.boss@swishhh.net', departmentId: ids.deptA, position: 'Head' });
  assert.equal(boss.status, 201, JSON.stringify(boss.body));
  const pmEmail = (await owner('GET', '/api/meta')).body.users.find((u: any) => u.id === ids.pm).email;
  const rep = await owner('POST', '/api/staff', { name: 'Org Report', email: pmEmail.toUpperCase(), departmentId: ids.deptA, managerId: boss.body.id });
  assert.equal(rep.status, 201);
  assert.equal(rep.body.userId, ids.pm, 'linked to the account by email');
  assert.equal((await owner('PATCH', `/api/staff/${boss.body.id}`, { managerId: rep.body.id })).status, 400, 'no reporting loop');
  assert.equal((await pm('POST', '/api/staff', { name: 'Nope' })).status, 403, 'only system admins edit');
  assert.equal((await member('GET', '/api/staff')).status, 403, 'not for team members');
  assert.equal((await pm('GET', '/api/staff')).status, 403, 'the org chart is for the PMO and admins');
  const list = (await owner('GET', '/api/staff')).body;
  assert.ok(list.some((s: any) => s.name === 'Org Report' && s.managerId === boss.body.id));
  const look = (await pm('GET', '/api/staff/lookup')).body;
  assert.ok(look.some((s: any) => s.name === 'Org Boss') && !look.some((s: any) => s.name === 'Org Report'), 'project managers look up people without an account');
});

test('the PMO closes a project directly, but with the closure documents', async () => {
  const mk = await owner('POST', '/api/projects', { name: 'Direct close', departmentId: ids.deptA, managerId: ids.pm, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 10), milestones: [{ name: 'Only one', date: addDays(sun, 3) }] });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  for (const t of mk.body.tasks.filter((x: any) => x.kind !== 'summary' && !x.systemKey)) assert.equal((await owner('PATCH', `/api/tasks/${t.id}`, { status: 'done', progress: 100 })).status, 200);
  const P = mk.body.project.id;
  assert.equal((await owner('POST', `/api/projects/${P}/closure-request`, { note: 'Done' })).status, 400, 'documents are needed');
  const done = await owner('POST', `/api/projects/${P}/closure-request`, { note: 'Done', ...closeDocs() });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.closed, true);
  assert.equal((await owner('GET', `/api/projects/${P}`)).body.project.health, 'done', 'closed at once');
});

test('the PMO sends an escalation straight to the executives; others raise the next step', async () => {
  const mk = await owner('POST', '/api/projects', { name: 'Straight up', departmentId: ids.deptA, managerId: ids.pm, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 20), milestones: [{ name: 'Needs the CEO', date: addDays(sun, 4) }] });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const ms = mk.body.tasks.find((t: any) => t.name === 'Needs the CEO');
  await owner('PUT', '/api/ladder-roles', { ceo: ids.cowner });
  assert.equal((await pm('POST', `/api/tasks/${ms.id}/escalations`, { note: 'x', level: 6 })).status, 403, 'only the PMO skips steps');
  const up = await owner('POST', `/api/tasks/${ms.id}/escalations`, { note: 'Decided in the weekly meeting', level: 6 });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.level, 6);
  assert.ok((await cowner('GET', '/api/my-actions')).body.some((a: any) => a.kind === 'escalation' && a.taskId === ms.id), 'the CEO is asked to act at once');
  assert.equal((await owner('POST', `/api/tasks/${ms.id}/escalations`, { level: 2 })).status, 400, 'not below what is already open');
});

test('a project waits for the projects it depends on: no progress, updates or baseline until they close', async () => {
  const mk = (name: string) => owner('POST', '/api/projects', { name, departmentId: ids.deptA, managerId: ids.pm, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 20), milestones: [{ name: `${name} step`, date: addDays(sun, 4) }] });
  const first = await mk('Goes first');
  const second = await mk('Waits');
  assert.equal(first.status, 201);
  const A = first.body.project.id;
  const B = second.body.project.id;
  assert.equal((await pm('PUT', `/api/projects/${B}/depends-on`, { ids: [A] })).status, 403, 'only the PMO links projects');
  assert.equal((await owner('PUT', `/api/projects/${B}/depends-on`, { ids: [B] })).status, 400, 'not on itself');
  const set = await owner('PUT', `/api/projects/${B}/depends-on`, { ids: [A] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.dependsOn[0].open, true);
  assert.equal((await owner('PUT', `/api/projects/${A}/depends-on`, { ids: [B] })).status, 400, 'no loop');
  const step = second.body.tasks.find((t: any) => t.name === 'Waits step');
  assert.equal((await pm('PATCH', `/api/tasks/${step.id}`, { status: 'in_progress', progress: 20 })).status, 409, 'progress waits');
  assert.equal((await pm('PATCH', `/api/tasks/${step.id}`, { name: 'Waits step, renamed' })).status, 200, 'the plan can be prepared');
  assert.equal((await pm('POST', `/api/projects/${B}/baseline`, {})).status, 409, 'the baseline waits');
  assert.ok((await pm('GET', '/api/projects')).body.find((p: any) => p.id === B).blockedBy.length === 1, 'shown as waiting');
  // A closes: B is free, its manager is told.
  for (const t of first.body.tasks.filter((x: any) => x.kind !== 'summary' && !x.systemKey)) await owner('PATCH', `/api/tasks/${t.id}`, { status: 'done', progress: 100 });
  assert.equal((await owner('POST', `/api/projects/${A}/closure-request`, { note: 'Done', ...closeDocs() })).status, 201);
  assert.equal((await pm('PATCH', `/api/tasks/${step.id}`, { status: 'in_progress', progress: 20 })).status, 200, 'free once it closed');
  assert.ok((await pm('GET', '/api/notifications')).body.some((n: any) => n.kind === 'project.unblocked' && n.projectId === B), 'the manager is told');
});

test('closure requests go to the PMO, not to owners and executives', async () => {
  const mk = await owner('POST', '/api/projects', { name: 'Close ask', departmentId: ids.deptA, managerId: ids.pm, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 10), milestones: [{ name: 'All of it', date: addDays(sun, 3) }] });
  for (const t of mk.body.tasks.filter((x: any) => x.kind !== 'summary' && !x.systemKey)) await owner('PATCH', `/api/tasks/${t.id}`, { status: 'done', progress: 100 });
  const P = mk.body.project.id;
  const asked = await pm('POST', `/api/projects/${P}/closure-request`, { note: 'Done', ...closeDocs() });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.ok((await owner('GET', '/api/my-actions')).body.some((a: any) => a.kind === 'closure' && a.projectId === P), 'the PMO is asked');
  assert.ok(!(await cowner('GET', '/api/my-actions')).body.some((a: any) => a.kind === 'closure'), 'not the owners');
  assert.ok(!(await cowner('GET', '/api/notifications')).body.some((n: any) => n.kind === 'closure.requested' && n.projectId === P), 'nor notified');
});

test('the org chart is the reference: editing a person there updates their account, and the other way round', async () => {
  const email = `sync.${Date.now()}@swishhh.net`;
  const u = await owner('POST', '/api/users', { email, name: 'Sync Short', roleId: 'member', departmentId: ids.deptA, sendEmail: false });
  assert.equal(u.status, 201, JSON.stringify(u.body));
  const s = await owner('POST', '/api/staff', { name: 'Sync Short', email, departmentId: ids.deptA });
  const ch = await owner('PATCH', `/api/staff/${s.body.id}`, { name: 'Sync Full Name', position: 'Analyst', departmentId: ids.deptB });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const acc = (await owner('GET', '/api/meta')).body.users.find((x: any) => x.email === email);
  assert.equal(acc.name, 'Sync Full Name');
  assert.equal(acc.title, 'Analyst');
  assert.equal(acc.departmentId, ids.deptB);
  assert.equal((await owner('PATCH', `/api/users/${u.body.id}`, { title: 'Senior Analyst' })).status, 200);
  assert.equal((await owner('GET', '/api/staff')).body.find((x: any) => x.id === s.body.id).position, 'Senior Analyst', 'copied back to the org chart');
});

test('@mentions: naming someone as @Full Name in a comment notifies them, linked to the milestone', async () => {
  const mk = await owner('POST', '/api/projects', { name: 'Mention project', departmentId: ids.deptA, managerId: ids.pm, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 20), milestones: [{ name: 'Mention step', date: addDays(sun, 5) }] });
  const ms = mk.body.tasks.find((t: any) => t.name === 'Mention step');
  const memberName = (await owner('GET', '/api/meta')).body.users.find((u: any) => u.id === ids.member).name;
  const r = await pm('PATCH', `/api/tasks/${ms.id}`, { status: 'in_progress', progress: 10, updateComment: `Started. @${memberName} please send the data.` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 300));
  const n = (await member('GET', '/api/notifications')).body.find((x: any) => x.kind === 'mention' && x.taskId === ms.id);
  assert.ok(n, 'the person named is told');
  assert.match(n.data.excerpt, /please send the data/);
  assert.ok(!(await pm('GET', '/api/notifications')).body.some((x: any) => x.kind === 'mention' && x.taskId === ms.id), 'not the writer');
});

test('whoever is given something is told: a risk, a co-ownership, a meeting action; the work shows in the pop-up', async () => {
  const mk = await owner('POST', '/api/projects', { name: 'Assign tells', departmentId: ids.deptA, managerId: ids.pm, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 20), milestones: [{ name: 'Tell step', date: addDays(sun, 5) }] });
  const P = mk.body.project.id;
  const ms = mk.body.tasks.find((t: any) => t.name === 'Tell step');
  const memberName = (await owner('GET', '/api/meta')).body.users.find((u: any) => u.id === ids.member).name;
  assert.equal((await owner('POST', `/api/projects/${P}/risks`, { title: 'Data late', ownerId: ids.member })).status, 201);
  assert.equal((await owner('PATCH', `/api/tasks/${ms.id}`, { coOwners: memberName })).status, 200);
  const notes = (await member('GET', '/api/notifications')).body.filter((n: any) => n.projectId === P);
  assert.ok(notes.some((n: any) => n.kind === 'risk.assigned'), 'the risk owner is told');
  assert.ok(notes.some((n: any) => n.kind === 'task.coowner'), 'the co-owner is told');
  const acts = (await member('GET', '/api/my-actions')).body.filter((a: any) => a.kind === 'note' && a.projectId === P);
  assert.ok(acts.some((a: any) => a.noteKind === 'risk.assigned') && acts.some((a: any) => a.noteKind === 'task.coowner'), 'and both wait in the pop-up');
});

test('the AI project manager reminds owners on a switched-on project, once per step; insights are for the PMO', async () => {
  const due = addDays(sun, 4);
  const mk = await owner('POST', '/api/projects', { name: 'AI follows', departmentId: ids.deptA, managerId: ids.pm, sponsor: 'Sponsor', startDate: sun, endDate: addDays(sun, 20), milestones: [{ name: 'AI step', date: due }] });
  const P = mk.body.project.id;
  const ms = mk.body.tasks.find((t: any) => t.name === 'AI step');
  await owner('PATCH', `/api/tasks/${ms.id}`, { assigneeId: ids.member });
  assert.equal((await member('PUT', `/api/projects/${P}/ai-pm`, { enabled: true })).status, 403, 'not a team member');
  assert.equal((await pm('PUT', `/api/projects/${P}/ai-pm`, { enabled: true })).status, 200, 'its manager switches it on');
  const r1 = (await owner('POST', '/api/ai-pm/run', { today: due })).body;
  assert.ok(r1.reminders >= 1, JSON.stringify(r1));
  const told = (await member('GET', '/api/notifications')).body.filter((n: any) => n.kind === 'ai.reminder' && n.taskId === ms.id);
  assert.equal(told.length, 1, 'the owner is reminded on the day');
  await owner('POST', '/api/ai-pm/run', { today: due });
  assert.equal((await member('GET', '/api/notifications')).body.filter((n: any) => n.kind === 'ai.reminder' && n.taskId === ms.id).length, 1, 'not twice for the same step');
  assert.ok((await pm('GET', `/api/projects/${P}/ai-pm`)).body.some((e: any) => e.action === 'reminder'), 'logged on the project');
  assert.equal((await pm('GET', '/api/insights')).status, 403, 'insights are for the PMO');
  assert.ok(Array.isArray((await owner('GET', '/api/insights')).body));
  const mine = (await member('GET', '/api/insights/me')).body;
  assert.ok(['strong', 'on_track', 'attention', 'not_enough'].includes(mine.label) && !('score' in mine), 'a person sees only their label and tip');
});

test('the guided tour opens until the person finishes or skips it', async () => {
  assert.equal((await member('GET', '/api/meta')).body.me.tourDone, false);
  assert.equal((await member('POST', '/api/me/tour-done', {})).status, 200);
  assert.equal((await member('GET', '/api/meta')).body.me.tourDone, true);
});

test('page tours: each is remembered once finished, and the role tour separately', async () => {
  assert.deepEqual((await member('GET', '/api/meta')).body.me.toursSeen, []);
  await member('POST', '/api/me/tour-done', { page: 'mywork' });
  await member('POST', '/api/me/tour-done', { page: 'mywork' });
  await member('POST', '/api/me/tour-done', { page: 'Not a page!' });
  const me = (await member('GET', '/api/meta')).body.me;
  assert.deepEqual(me.toursSeen, ['mywork'], 'once, and only a real page name');
});

test('each sign-in has its own opaque marker, so the pop-up opens once per sign-in', async () => {
  const s = (await member('GET', '/api/meta')).body.session;
  assert.match(s, /^[0-9a-f]{16}$/);
  assert.equal((await member('GET', '/api/meta')).body.session, s, 'the same sign-in keeps it');
  assert.notEqual((await owner('GET', '/api/meta')).body.session, s, 'another sign-in has another');
});

test('a department head also sees, in the plan, the plan projects of the projects they run in other departments', async () => {
  const plan = (await owner('GET', '/api/transformation')).body;
  const free = plan.flatMap((c: any) => c.dimensions).flatMap((d: any) => d.initiatives).find((i: any) => i.projectIds.length === 0);
  const made = await owner('POST', '/api/projects', { name: 'Run by the head, elsewhere', initiativeId: free.id, departmentId: ids.deptB, managerId: ids.head, startDate: sun, endDate: addDays(sun, 30) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const seen = (await head('GET', '/api/transformation')).body.flatMap((c: any) => c.dimensions).flatMap((d: any) => d.initiatives).map((i: any) => i.id);
  assert.ok(seen.includes(free.id), 'the plan project of the project they run');
});
