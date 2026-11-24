import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerEmail, assignmentEmail, eventEmail, passwordEmail, testEmail, weeklyEmail } from '../server/mail';
import { briefingEmail } from '../server/briefingEmail';

const p = { who: 'Nora Manager', codes: 'PRJ-1, PRJ-2', url: 'https://pmo.example/#/updates' };
const brief = {
  dateLabel: 'Thursday, 29 October 2026',
  summary: 'PRJ-1 is late <b>now</b>.',
  priorities: ['File the update for PRJ-1.', 'Unblock "Contract" in PRJ-2.'],
  projects: [
    { code: 'PRJ-1', name: 'Alpha', health: 'at_risk' as const, progress: 40, endDate: '2026-12-01', done: 2, open: 3, overdue: 1, blocked: 1 },
    { code: 'PRJ-2', name: 'Beta & Co', health: 'done' as const, progress: 100, endDate: '2026-10-01', done: 5, open: 0, overdue: 0, blocked: 0 },
  ],
  upcoming: [{ code: 'PRJ-1', task: 'Contract', due: '2026-10-27', daysLeft: -2 }],
};

/** Every email is one table-based page: no <div> layout, no SVG, no images, no scripts. */
function outlookSafe(html: string) {
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('role="presentation"'));
  assert.ok(!/<svg|<img|<script|<div style="font:/i.test(html));
}

test('without a briefing the weekly email is the plain reminder', () => {
  const m = weeklyEmail(p, null);
  assert.equal(m.subject, 'SWiSH PMO: your weekly update is due');
  assert.ok(m.text.includes('Your weekly update is still due for: PRJ-1, PRJ-2.'));
  assert.ok(!m.text.includes('AI'));
  outlookSafe(m.html);
  assert.deepEqual(weeklyEmail(p, { ...brief, summary: '', priorities: [] }), m, 'an empty briefing counts as none');
});

test('the weekly email with a briefing: numbers, AI summary, charts and the update due, escaped', () => {
  const m = weeklyEmail(p, brief);
  assert.equal(m.subject, 'SWiSH PMO: your weekly briefing, update due (29 October 2026)');
  outlookSafe(m.html);
  assert.ok(m.text.startsWith('Hello Nora,'));
  assert.ok(m.text.includes('Your weekly update is due for: PRJ-1, PRJ-2.'));
  assert.ok(m.text.includes('1. File the update for PRJ-1.\n2. Unblock "Contract" in PRJ-2.'));
  assert.ok(m.html.includes('PRJ-1 is late &lt;b&gt;now&lt;/b&gt;.'));
  assert.ok(m.html.includes('Unblock &quot;Contract&quot; in PRJ-2.'));
  assert.ok(m.html.includes('Beta &amp; Co'));
  assert.ok(m.html.includes('Write the update'));
  assert.ok(m.html.includes('2d late'));
  assert.ok(m.html.includes('width="40%"'), 'the progress bar is a table cell of the right width');
  assert.ok(m.html.includes('>40%<') && m.html.includes('>1</div>'), 'average progress of active projects, overdue count');
});

test('the projects briefing on its own', () => {
  const m = briefingEmail({ ...brief, who: 'Nora Manager', url: 'https://pmo.example' });
  assert.equal(m.subject, 'SWiSH PMO: your projects briefing, 29 October 2026');
  assert.ok(m.html.includes('Open SWiSH PMO') && !m.html.includes('Write the update'));
  outlookSafe(m.html);
});

test('event, assignment, password and test emails share the layout and keep their text', () => {
  const ev = eventEmail('deadline.pending', { who: 'Nora M', by: 'Sam', project: 'Alpha', code: 'PRJ-1', name: 'Pilot', from: '2026-11-01', to: '2026-11-15', reason: 'Vendor <late>', note: '', codes: '', delivery: '', url: 'https://pmo.example/x' });
  assert.ok(ev.text.includes('Sam asks to move the deadline of "Pilot" (PRJ-1 Alpha) from 2026-11-01 to 2026-11-15. Reason: Vendor <late>.'));
  assert.ok(ev.html.includes('Vendor &lt;late&gt;') && ev.html.includes('Decide in SWiSH PMO') && ev.html.includes('A deadline change needs your decision'));
  outlookSafe(ev.html);
  const as = assignmentEmail('task.assigned', { who: 'Nora', by: 'Sam', project: 'Alpha', code: 'PRJ-1', name: 'Pilot', url: '' });
  assert.ok(as.text.includes('Sam made you the owner of "Pilot" in the project PRJ-1 Alpha.'));
  assert.ok(!as.html.includes('Open in SWiSH PMO'), 'no button without a link');
  outlookSafe(as.html);
  const pw = passwordEmail('Nora Manager', 'abc-def-ghi', 24);
  assert.ok(pw.html.includes('abc-def-ghi') && pw.html.includes('24 hours'));
  outlookSafe(pw.html);
  outlookSafe(testEmail().html);
});

test('the answer to an emailed question: escaped, Arabic laid out right to left, linked projects', () => {
  const m = answerEmail({ who: 'Nora Manager', subject: 'SWiSH PMO: weekly', question: 'Late <projects>?', answer: 'مشروع ألفا متأخر\nسبب: المورد', projects: [{ code: 'PRJ-1', name: 'Alpha & Co', url: 'https://pmo.example/#/projects/1' }] });
  assert.equal(m.subject, 'Re: SWiSH PMO: weekly');
  assert.equal(answerEmail({ ...{ who: 'N', question: 'q', answer: 'a', projects: [] }, subject: 'RE: x' }).subject, 'RE: x');
  outlookSafe(m.html);
  assert.ok(m.html.includes('dir="rtl"') && m.html.includes('متأخر<br>سبب'));
  assert.ok(m.html.includes('Late &lt;projects&gt;?') && m.html.includes('Alpha &amp; Co') && m.html.includes('href="https://pmo.example/#/projects/1"'));
  assert.ok(m.text.includes('- PRJ-1 Alpha & Co: https://pmo.example/#/projects/1'));
});

test('the daily follow-up: grouped by project, escaped, with the reminder count and the test-mode banner', async () => {
  const { followupEmail } = await import('../server/followupEmail');
  const items = [
    { projectCode: 'PRJ-1', projectName: 'Alpha & Co', task: 'Contract <signed>', due: '2026-10-27', status: 'todo', progress: 0, reason: '5 days overdue', tone: 'late' as const, before: 1 },
    { projectCode: 'PRJ-1', projectName: 'Alpha & Co', task: 'Training', due: '2026-11-04', status: 'todo', progress: 0, reason: 'Due in 3 days and not started', tone: 'risk' as const, before: 0, ownerName: 'Nader' },
  ];
  const m = followupEmail({ who: 'Nora Manager', dateLabel: 'Sunday, 1 November 2026', intro: 'The contract is late.', items, url: 'https://pmo.example/#/my-work' });
  assert.equal(m.subject, 'SWiSH PMO: 1 overdue milestone needs your update');
  outlookSafe(m.html);
  assert.ok(m.html.includes('Contract &lt;signed&gt;') && m.html.includes('Alpha &amp; Co') && m.html.includes('2nd reminder') && m.html.includes('Owner: Nader (no account yet)'));
  assert.ok(m.text.includes('- Contract <signed>: 5 days overdue (2nd reminder).'));
  const t = followupEmail({ who: 'Nader', dateLabel: 'x', intro: 'y', items: [items[1]], url: '', preview: { name: 'Nader', email: null } });
  assert.equal(t.subject, '[TEST for Nader] SWiSH PMO: 1 milestone needs your update');
  assert.ok(t.html.includes('Test mode.') && !t.html.includes('Open my work'));
});

test('the escalation email: level, who was asked and how often, escaped', async () => {
  const { escalationEmail } = await import('../server/followupEmail');
  const m = escalationEmail({
    who: 'Nora Manager',
    dateLabel: 'x',
    url: 'https://pmo.example',
    items: [{ projectCode: 'PRJ-1', projectName: 'Alpha', task: 'Go <live>', due: '2026-10-27', status: 'todo', progress: 0, reason: '5 days overdue', tone: 'late', before: 0, level: 2, askedName: 'Omar', askedTimes: 3, since: '2026-10-20' }],
  });
  assert.equal(m.subject, 'SWiSH PMO: escalation, 1 milestone without an answer');
  outlookSafe(m.html);
  assert.ok(m.html.includes('Go &lt;live&gt;') && m.html.includes('Level 2') && m.html.includes('Omar was asked 3 times since 20 Oct 2026'));
  assert.ok(m.text.includes('[Level 2] Go <live>: 5 days overdue.'));
});

test('the recommendations email: numbered, each with its reason, escaped, and how to approve some', async () => {
  const { recommendationEmail } = await import('../server/followupEmail');
  const m = recommendationEmail({ who: 'Nora Manager', dateLabel: 'x', project: 'PRJ-1 Alpha & Co', summary: 'Late <now>.', url: 'https://pmo.example/#/projects/1', items: [{ action: 'Move "Go-live" to 1 Dec.', why: 'It is 5 days late.' }, { action: 'Set priority to critical.', why: 'Most is late.' }] });
  assert.equal(m.subject, 'SWiSH PMO: 2 recommendations for PRJ-1 Alpha & Co');
  outlookSafe(m.html);
  assert.ok(m.html.includes('Late &lt;now&gt;.') && m.html.includes('Move &quot;Go-live&quot; to 1 Dec.') && m.html.includes('1 and 3'));
  assert.ok(m.text.includes('1. Move "Go-live" to 1 Dec.\n   Why: It is 5 days late.'));
});
