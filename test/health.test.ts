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
