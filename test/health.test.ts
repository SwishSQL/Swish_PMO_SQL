// The tracker's flags on a milestone, worked out from the milestone itself (calendar days, as the tracker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { milestoneFlags } from '../shared/health';

const today = '2026-10-14';
const m = (over: Partial<Parameters<typeof milestoneFlags>[0]> = {}) => ({
  status: 'in_progress',
  date: '2026-11-30',
  progress: 30,
  blocker: null,
  lastUpdateOn: '2026-10-13',
  escalatedOn: null,
  ...over,
});

test('past its deadline and open is overdue; done or cancelled never is', () => {
  assert.equal(milestoneFlags(m({ date: '2026-10-13' }), today).overdue, true);
  assert.equal(milestoneFlags(m({ date: '2026-10-14' }), today).overdue, false);
  assert.equal(milestoneFlags(m({ date: '2026-10-01', status: 'done' }), today).overdue, false);
  assert.equal(milestoneFlags(m({ date: '2026-10-01', status: 'cancelled' }), today).open, false);
});

test('needs an update after more than 7 days without a report, or never reported', () => {
  assert.equal(milestoneFlags(m({ lastUpdateOn: '2026-10-07' }), today).needsUpdate, false);
  assert.equal(milestoneFlags(m({ lastUpdateOn: '2026-10-06' }), today).needsUpdate, true);
  assert.equal(milestoneFlags(m({ lastUpdateOn: null }), today).needsUpdate, true);
});

test('at risk: within 4 days and not started', () => {
  assert.equal(milestoneFlags(m({ date: '2026-10-18', status: 'todo', progress: 0 }), today).autoAtRisk, true);
  assert.equal(milestoneFlags(m({ date: '2026-10-19', status: 'todo', progress: 0 }), today).autoAtRisk, false);
  assert.equal(milestoneFlags(m({ date: '2026-10-18', progress: 20 }), today).autoAtRisk, false);
});

test('an early warning is a blocker on a milestone not late yet', () => {
  assert.equal(milestoneFlags(m({ blocker: 'Vendor' }), today).earlyWarning, true);
  assert.equal(milestoneFlags(m({ blocker: '   ' }), today).earlyWarning, false);
  assert.equal(milestoneFlags(m({ status: 'blocked' }), today).earlyWarning, true);
});

test('escalation: missing when overdue and never escalated, late when first raised after the deadline', () => {
  assert.equal(milestoneFlags(m({ date: '2026-10-10' }), today).escalationMissing, true);
  assert.equal(milestoneFlags(m({ date: '2026-10-10', escalatedOn: '2026-10-10' }), today).escalationLate, false);
  assert.equal(milestoneFlags(m({ date: '2026-10-10', escalatedOn: '2026-10-11' }), today).escalationLate, true);
});

test('project health and stage are read from the plan, never typed', async () => {
  const { deriveHealth, deriveStage } = await import('../shared/autoStatus');
  const T = (id: number, o: Record<string, unknown>) =>
    ({ id, parentId: null, kind: 'milestone', name: `m${id}`, startDate: '2026-01-01', endDate: '2026-12-01', status: 'todo', progress: 0, blocker: null, notRequired: false, ...o }) as any;
  const base = { start: '2026-01-01', end: '2026-12-31', health: 'on_track' as const, stage: 'initiation' as const, projectBlockers: 0, today: '2026-06-30' };
  const phases = ['Initiation', 'Planning', 'Execution', 'Monitoring & Control', 'Closure'].map((n, i) => T(100 + i, { kind: 'summary', name: n }));
  // Half the year gone and half done: on track. A milestone past its deadline: delayed. A blocker: at risk.
  assert.equal(deriveHealth({ ...base, progress: 50, tasks: [] }), 'on_track');
  assert.equal(deriveHealth({ ...base, progress: 50, tasks: [T(1, { endDate: '2026-06-01' })] }), 'at_risk', 'one late milestone: amber');
  assert.equal(deriveHealth({ ...base, progress: 50, tasks: [T(1, { endDate: '2026-06-01' }), T(2, { endDate: '2026-06-10' })] }), 'off_track', 'two late: red');
  assert.equal(deriveHealth({ ...base, progress: 50, critical: new Set([1]), tasks: [T(1, { endDate: '2026-06-01' })] }), 'off_track', 'late on the critical path: red');
  assert.equal(deriveHealth({ ...base, progress: 25, tasks: [] }), 'off_track');
  assert.equal(deriveHealth({ ...base, progress: 42, tasks: [] }), 'at_risk');
  assert.equal(deriveHealth({ ...base, progress: 50, tasks: [T(1, { blocker: 'Vendor' })] }), 'at_risk');
  assert.equal(deriveHealth({ ...base, progress: 50, projectBlockers: 1, tasks: [] }), 'at_risk');
  assert.equal(deriveHealth({ ...base, health: 'done', progress: 10, tasks: [] }), 'done', 'only a closure finishes');
  assert.equal(deriveHealth({ ...base, start: '2026-08-01', progress: 0, tasks: [] }), 'not_started');
  // The stage is the phase of the earliest open milestone, and never goes back.
  const plan = [...phases, T(1, { parentId: 100, status: 'done' }), T(2, { parentId: 101, status: 'done' }), T(3, { parentId: 102 }), T(4, { parentId: 104 })];
  assert.equal(deriveStage({ ...base, progress: 50, tasks: plan }), 'execution');
  assert.equal(deriveStage({ ...base, stage: 'monitoring', progress: 50, tasks: plan }), 'monitoring', 'never back');
  // No lifecycle phases (imported): Monitoring at 70% of the milestones done.
  const flat = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => T(i, { status: i <= 7 ? 'done' : 'todo' }));
  assert.equal(deriveStage({ ...base, stage: 'execution', progress: 70, tasks: flat }), 'monitoring');
});
