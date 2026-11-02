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
import { addDays, todayIso, weekday } from '../shared/dates';

const ROOT = path.resolve(__dirname, '..');
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
function client(): Call {
  let cookie = '';
  return async (method, url, body) => {
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
    await activate(c, u.body.inviteToken);
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
  assert.equal((await member('GET', `/api/projects/${ids.project}`)).status, 200);
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
  const b = await member('POST', `/api/tasks/${ids.design}/escalations`, { toName: 'Test Owner', note: 'Still waiting' });
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.deepEqual([a.body.level, b.body.level], [1, 2]);
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
    await activate(c, u.body.inviteToken);
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
  assert.equal(seen.tasks.filter((t: any) => t.kind !== 'summary').length, 2);
  const team = await head('PUT', `/api/projects/${pid}/members`, { members: [{ userId: ids.pm, role: 'Project owner' }, { userId: ids.member, role: 'Member' }] });
  assert.equal(team.status, 200, JSON.stringify(team.body));

  // A member sees the project but only the tasks given to them.
  assert.equal((await member('GET', `/api/projects/${pid}`)).body.tasks.length, 0);
  const alpha = seen.tasks.find((t: any) => t.name === 'Alpha');
  await pm('PATCH', `/api/tasks/${alpha.id}`, { assigneeId: ids.member });
  const mine = (await member('GET', `/api/projects/${pid}`)).body;
  assert.deepEqual(mine.tasks.filter((t: any) => t.kind !== 'summary').map((t: any) => t.name), ['Alpha'], 'their own milestone, with only the phase above it');
  assert.deepEqual(mine.project.milestones.map((m: any) => m.name), ['Alpha']);
  assert.deepEqual((await member('GET', '/api/milestones')).body.filter((m: any) => m.projectId === pid).map((m: any) => m.name), ['Alpha']);
  assert.equal((await member('GET', '/api/search?q=beta')).body.milestones.length, 0);
  // The owner of the project still sees both.
  assert.equal((await pm('GET', `/api/projects/${pid}`)).body.tasks.filter((t: any) => t.kind !== 'summary').length, 2);
});

// ---- Closing a project --------------------------------------------------------------------------------

test('a project closes only when a PMO admin approves a request', async () => {
  const P = ids.project;
  // No project finishes without its Delivery Document: a link to it, or the file.
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { note: 'Everything is delivered' })).status, 400, 'a request needs the closure documents');
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { note: 'x', reportFile: closeDocs().reportFile })).status, 400, 'the signed checklist too');
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { note: 'x', deliveryUrl: 'not a link', ...closeDocs() })).status, 400);
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { note: 'x', deliveryUrl: 'javascript:alert(1)', ...closeDocs() })).status, 400);
  const req1 = await pm('POST', `/api/projects/${P}/closure-request`, { note: 'Everything is delivered', deliveryUrl: 'https://swish.example/sites/pmo/delivery.docx', ...closeDocs() });
  assert.equal(req1.status, 201, JSON.stringify(req1.body));
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, { deliveryUrl: 'https://swish.example/again', ...closeDocs() })).status, 409, 'one request at a time');
  assert.equal((await member('POST', `/api/projects/${P}/closure-request`, {})).status, 403, 'an employee cannot even ask');

  // No other door closes it.
  assert.equal((await pm('PATCH', `/api/projects/${P}`, { stage: 'closed' })).status, 403);
  assert.equal((await pm('PATCH', `/api/projects/${P}`, { health: 'done' })).status, 403);
  assert.equal((await pm('PUT', `/api/projects/${P}/updates/${todayIso()}`, { health: 'done', progress: 100 })).status, 403);

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
  assert.notEqual(detail.project.stage, 'closed');
  assert.equal(detail.closure.status, 'rejected');
  assert.equal(detail.closure.decisionNote, 'Two milestones are still open');
  assert.ok((await pm('GET', '/api/notifications')).body.some((n: any) => n.kind === 'closure.decided' && n.data.decision === 'reject'));
  assert.equal((await owner('POST', `/api/closure-requests/${waiting[0].id}/decide`, { decision: 'approve' })).status, 409, 'decided once');

  // Asked again and approved: now it is closed.
  await pm('POST', `/api/projects/${P}/closure-request`, { note: 'Done now', deliveryUrl: 'https://swish.example/final', ...closeDocs() });
  const again = (await owner('GET', '/api/closure-requests/pending')).body[0];
  assert.equal((await owner('POST', `/api/closure-requests/${again.id}/decide`, { decision: 'approve' })).status, 200);
  detail = (await pm('GET', `/api/projects/${P}`)).body;
  assert.equal(detail.project.stage, 'closed');
  assert.equal(detail.project.health, 'done');
  assert.equal((await pm('POST', `/api/projects/${P}/closure-request`, {})).status, 409, 'already closed');

  // Those who approve may also close directly, and it is all on the record.
  assert.equal((await owner('PATCH', `/api/projects/${P}`, { stage: 'execution' })).status, 200);
  assert.equal((await owner('PATCH', `/api/projects/${P}`, { stage: 'closed' })).status, 200);
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
  assert.deepEqual(made.body.tasks.filter((t: any) => t.kind !== 'summary').map((t: any) => t.name).sort(), ['First', 'Second']);
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
    draft: { name: 'Cold store', nameAr: '', departmentId: 0, ownerId: 0, sponsor: '', priority: 'medium', objective: '', scope: '', startDate: '', endDate: '', phases: ['Pilot', 'Definition', 'Not a phase'], milestones: [] },
  };
  const before = aiCalls.length;
  const r = await head('POST', '/api/ai/project-draft', say('New project: cold store'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.questions, ['Which department runs it: Supply Chain or Finance?', 'Who will own it?', 'When does it start and end?'], 'the questions reach the person, empty ones dropped');
  assert.deepEqual(r.body.draft.phases, ['Definition', 'Pilot'], 'only real phases, in their fixed order');
  const sys = JSON.stringify(aiCalls[before]);
  assert.ok(sys.includes('COMPLETE PROJECT') && sys.includes('ASK'), 'the model is told to ask for what is missing');

  // A model that says nothing about phases, or leaves none, keeps them all; no questions means none.
  aiAnswer = { reply: 'Done.', assumptions: [], draft: { name: 'Cold store', departmentId: ids.deptA, phases: [], milestones: [] } };
  const r2 = await head('POST', '/api/ai/project-draft', say('Supply chain'));
  assert.equal(r2.body.draft.phases.length, 10);
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
const closeDocs = () => ({
  reportFile: { name: 'Closure Report.pdf', data: Buffer.from('%PDF report').toString('base64') },
  checklistFile: { name: 'Sign-Off Checklist.pdf', data: Buffer.from('%PDF checklist').toString('base64') },
});
const mailsTo = (email: string) => mails.filter((m) => m.to.includes(email));
const loginRaw = (email: string, password: string) => client()('POST', '/api/auth/login', { email, password });

test('first sign-in by email: the password goes to the mailbox, is temporary, and must be replaced', async () => {
  assert.equal((await client()('GET', '/api/auth/config')).body.emailSignIn, true);
  const email = 'newhire.test@swishhh.net';
  const created = await owner('POST', '/api/users', { email, name: 'Nadia Newhire', roleId: 'member' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
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
  assert.equal(mailsTo(email).length, 1);
  const m = mailsTo(email)[0];
  assert.equal(m.to.length, 1);
  assert.match(m.raw, /Subject:[\s\S]*SWiSH[ _]PMO/i, 'the subject names the system');
  assert.ok(!/^cc:/im.test(m.raw) && !/copy-list@/i.test(m.raw), 'a password is never copied to a list');
  assert.match(mailText(m.raw), /Hello Nadia/);
  assert.ok(!/[؀-ۿ]/.test(mailText(m.raw)), 'emails are in English only');
  const temp = tempOf(m);

  // Asking again inside the cool-down changes nothing: still one email, and the first password still works.
  assert.deepEqual((await anon('POST', '/api/auth/first-access', { email })).body, { sent: true });
  assert.equal(mailsTo(email).length, 1);

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
  assert.equal(mailsTo(email).length, 0);
  // Still waiting for its first sign-in, and the link the admin got still opens the account.
  const stuck = (await owner('GET', '/api/meta')).body.users.find((u: any) => u.email === email);
  assert.equal(stuck.pending, true);
  const opened = await client()('POST', '/api/auth/activate', { token: created.body.inviteToken, password: 'Chosen-By-Link-1', confirm: 'Chosen-By-Link-1' });
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
  const sent = mailsTo(email);
  assert.equal(sent.length, 2, 'a second email after the reset');
  assert.equal((await loginRaw(email, tempOf(sent[1]))).status, 200);

  // While someone is on an emailed password, an admin can replace it with a link: that password stops working.
  const email2 = 'switch.test@swishhh.net';
  const made = await owner('POST', '/api/users', { email: email2, name: 'Sara Switch', roleId: 'member' });
  await client()('POST', '/api/auth/first-access', { email: email2 });
  const temp2 = tempOf(mailsTo(email2)[0]);
  const link = await owner('POST', `/api/users/${made.body.id}/invite`);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.equal((await loginRaw(email2, temp2)).status, 403);
  assert.equal((await client()('POST', '/api/auth/activate', { token: link.body.inviteToken, password: 'Chosen-By-Link-2', confirm: 'Chosen-By-Link-2' })).status, 200);
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
  const goneClient = client();
  await activate(goneClient, gone.body.inviteToken);
  const assigned = await owner('PATCH', `/api/tasks/${ids.design}`, { assigneeId: gone.body.id });
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
  const dead = await client()('POST', '/api/auth/activate', { token: pending.body.inviteToken, password: 'Some-Password-123', confirm: 'Some-Password-123' });
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
  assert.equal((await pm('PUT', `/api/projects/${ids.project}/members`, { members: [...team, { userId: other.body.id, role: 'Member' }] })).status, 400, 'a manager adds only people of the department to the team');
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

test('a new project has the fixed phases: the ticked ones in the window, the rest marked Not required', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const base = { name: 'Phased project', departmentId: meta.departments[0].id, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 59) };
  const PHASES = ['Definition', 'Data Collection', 'Analysis', 'Design', 'Build', 'Validation', 'Pilot', 'Rollout', 'Approval', 'Closeout'];
  const pick = ['Definition', 'Design', 'Closeout'];
  const made = await owner('POST', '/api/projects', { ...base, phases: pick });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pid = made.body.project.id;
  const plan = (await pm('GET', `/api/projects/${pid}`)).body.tasks.filter((t: any) => t.kind === 'summary');
  assert.deepEqual(plan.map((t: any) => t.name), PHASES, 'always all ten, in the fixed order');
  assert.deepEqual(plan.filter((t: any) => t.notRequired).map((t: any) => t.name), PHASES.filter((p) => !pick.includes(p)));
  const used = plan.filter((t: any) => !t.notRequired);
  assert.equal(used[0].startDate, sun);
  assert.ok(used[0].endDate < used[1].startDate && used[1].endDate < used[2].startDate, 'one after the other');
  assert.equal(used[2].endDate, addDays(sun, 59), 'together they fill the project window');
  // Nothing in a phase yet: the project has no work, so no progress, and the phases are not counted as work.
  assert.equal((await pm('GET', `/api/projects/${pid}`)).body.project.progress, 0);

  // Work cannot go into a phase that is not required, until it is switched back on.
  const skipped = plan.find((t: any) => t.name === 'Pilot');
  const refused = await pm('POST', `/api/projects/${pid}/tasks`, { kind: 'milestone', name: 'Try', startDate: sun, endDate: sun, parentId: skipped.id });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal((await pm('PATCH', `/api/tasks/${skipped.id}`, { notRequired: false })).status, 200);
  assert.equal((await pm('POST', `/api/projects/${pid}/tasks`, { kind: 'milestone', name: 'Try', startDate: sun, endDate: sun, parentId: skipped.id })).status, 201);
  // A phase with work in it cannot be marked, and only a phase can be.
  assert.equal((await pm('PATCH', `/api/tasks/${skipped.id}`, { notRequired: true })).status, 400);
  const task = (await pm('GET', `/api/projects/${pid}`)).body.tasks.find((t: any) => t.name === 'Try');
  assert.equal((await pm('PATCH', `/api/tasks/${task.id}`, { notRequired: true })).status, 400);
  // The members of the team may not decide which phases a project needs.
  const empty = plan.find((t: any) => t.name === 'Build');
  assert.equal((await member('PATCH', `/api/tasks/${empty.id}`, { notRequired: false })).status, 403);

  // Not saying anything keeps every phase.
  const all = await owner('POST', '/api/projects', base);
  const every = (await pm('GET', `/api/projects/${all.body.project.id}`)).body.tasks.filter((t: any) => t.kind === 'summary');
  assert.equal(every.length, 10);
  assert.equal(every.filter((t: any) => t.notRequired).length, 0);
});

test('the delivery document: a file is kept, served only as a download, and only to who can see the project', async () => {
  const meta = (await owner('GET', '/api/meta')).body;
  const made = await owner('POST', '/api/projects', { name: 'Delivered project', departmentId: meta.departments[0].id, managerId: ids.pm, startDate: sun, endDate: addDays(sun, 30) });
  const pid = made.body.project.id;
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
    phases: ['Definition', 'Build', 'Rollout'],
    milestones: [
      { name: 'Charter signed', date: addDays(sun, 3) },
      { name: 'Go live', date: addDays(sun, 30), phase: 'Rollout' },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pid = made.body.project.id;
  let plan = (await pm('GET', `/api/projects/${pid}`)).body.tasks;
  const byName = (n: string) => plan.find((t: any) => t.name === n);
  assert.equal(byName('Charter signed').parentId, byName('Definition').id, 'placed in the phase its date falls in');
  assert.equal(byName('Go live').parentId, byName('Rollout').id, 'placed in the phase it names');

  const post = (body: any) => pm('POST', `/api/projects/${pid}/tasks`, { startDate: sun, endDate: addDays(sun, 2), ...body });
  assert.equal((await post({ kind: 'task', name: 'Loose' })).status, 400, 'not at the top of the plan');
  assert.equal((await post({ kind: 'task', name: 'In a phase', parentId: byName('Build').id })).status, 400, 'not straight inside a phase');
  assert.equal((await post({ kind: 'milestone', name: 'Inside a milestone', parentId: byName('Go live').id })).status, 400);
  const ok = await post({ kind: 'task', name: 'Prepare the charter', parentId: byName('Charter signed').id, endDate: addDays(sun, 45) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await post({ kind: 'milestone', name: 'Build done', parentId: byName('Build').id })).status, 201);
  plan = (await pm('GET', `/api/projects/${pid}`)).body.tasks;
  assert.equal((await post({ kind: 'task', name: 'Under a task', parentId: byName('Prepare the charter').id })).status, 400, 'not inside another task');

  // Moving and retyping keep the shape.
  const task = byName('Prepare the charter');
  assert.equal((await pm('PATCH', `/api/tasks/${task.id}`, { parentId: byName('Build').id })).status, 400, 'a task cannot be moved into a phase');
  assert.equal((await pm('PATCH', `/api/tasks/${task.id}`, { parentId: byName('Go live').id })).status, 200, 'but into another milestone');
  assert.equal((await pm('PATCH', `/api/tasks/${byName('Go live').id}`, { kind: 'task' })).status, 400, 'a milestone with tasks in it stays a milestone');

  // The phase spans the work inside its milestones; the milestone keeps its own date.
  plan = (await pm('GET', `/api/projects/${pid}`)).body.tasks;
  assert.equal(byName('Go live').endDate, addDays(sun, 30));
  assert.equal(byName('Rollout').endDate, addDays(sun, 45), 'the task after the milestone date widens the phase');
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
  const plan = (await member('GET', '/api/transformation')).body;
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
  assert.deepEqual(find((await pm('GET', '/api/transformation')).body).projectIds, [ids.project]);
  assert.deepEqual(find((await outsider('GET', '/api/transformation')).body).projectIds, [], 'not to someone who cannot see it');
  assert.equal((await pm('GET', `/api/projects/${ids.project}`)).body.project.initiativeId, demand.id);

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
  const ms = detail.tasks.filter((t: any) => t.kind === 'milestone');
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
