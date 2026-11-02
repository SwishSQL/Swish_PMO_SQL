// The working calendar and the scheduling that runs on it. 2026-10-15 is a Thursday, 16-17 the weekend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCalendar } from '../shared/calendar';
import { propagate } from '../shared/schedule';
import type { Dependency, Task } from '../shared/types';

const plain = makeCalendar();
const eid = makeCalendar([
  { date: '2026-10-25', name: 'Eid', nameAr: 'العيد' },
  { date: '2026-10-26', name: 'Eid', nameAr: 'العيد' },
]);

test('Friday and Saturday are off, Sunday to Thursday are working days', () => {
  assert.deepEqual(
    ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'].map((d) => plain.isWorkday(d)),
    [true, false, false, true],
  );
});

test('a holiday is off and carries its name', () => {
  assert.equal(eid.isWorkday('2026-10-25'), false);
  assert.equal(eid.holiday('2026-10-26')?.nameAr, 'العيد');
  assert.equal(eid.holiday('2026-10-27'), undefined);
});

test('next working day: itself, or past the weekend and holidays', () => {
  assert.equal(plain.nextWorkday('2026-10-15'), '2026-10-15');
  assert.equal(plain.nextWorkday('2026-10-16'), '2026-10-18');
  assert.equal(eid.nextWorkday('2026-10-23'), '2026-10-27');
});

test('adding working days counts from the day after', () => {
  assert.equal(plain.addWorkdays('2026-10-15', 1), '2026-10-18'); // Thursday + 1 = Sunday
  assert.equal(plain.addWorkdays('2026-10-16', 1), '2026-10-18'); // a Friday finish: Sunday, not Monday
  assert.equal(plain.addWorkdays('2026-10-15', 0), '2026-10-15');
  assert.equal(plain.addWorkdays('2026-10-17', 0), '2026-10-18');
  assert.equal(eid.addWorkdays('2026-10-22', 1), '2026-10-27');
});

test('working days between two dates, both counted', () => {
  assert.equal(plain.workdays('2026-10-18', '2026-10-22'), 5);
  assert.equal(plain.workdays('2026-10-15', '2026-10-18'), 2);
  assert.equal(eid.workdays('2026-10-25', '2026-10-29'), 3);
  assert.equal(plain.workdays('2026-10-22', '2026-10-18'), 0);
});

// ---- Pushing successors -------------------------------------------------------------

const task = (id: number, start: string, end: string, kind: Task['kind'] = 'task') =>
  ({ id, parentId: null, kind, startDate: start, endDate: end, progress: 0 }) as Pick<Task, 'id' | 'parentId' | 'kind' | 'startDate' | 'endDate' | 'progress'>;
const link = (pred: number, succ: number, lagDays = 0) => ({ id: pred * 100 + succ, projectId: 1, predecessorId: pred, successorId: succ, lagDays }) as Dependency;

test('a successor starts on the first working day after its predecessor and keeps its working length', () => {
  const tasks = [task(1, '2026-10-18', '2026-10-22'), task(2, '2026-10-18', '2026-10-22')];
  const moved = propagate(tasks, [link(1, 2)], 1);
  assert.deepEqual(moved.get(2), { startDate: '2026-10-25', endDate: '2026-10-29' });
});

test('holidays push it further and stretch it over the days off', () => {
  const tasks = [task(1, '2026-10-18', '2026-10-22'), task(2, '2026-10-18', '2026-10-22')];
  const moved = propagate(tasks, [link(1, 2)], 1, eid);
  // Sunday 25 and Monday 26 are Eid: starts Tuesday, five working days run to Monday 2 November.
  assert.deepEqual(moved.get(2), { startDate: '2026-10-27', endDate: '2026-11-02' });
});

test('a milestone lands on a working day and stays one day', () => {
  const tasks = [task(1, '2026-10-18', '2026-10-22'), task(2, '2026-10-20', '2026-10-20', 'milestone')];
  assert.deepEqual(propagate(tasks, [link(1, 2)], 1).get(2), { startDate: '2026-10-25', endDate: '2026-10-25' });
});

test('lag counts working days, a lead counts calendar days then lands on a working day', () => {
  const lag = propagate([task(1, '2026-10-18', '2026-10-22'), task(2, '2026-10-18', '2026-10-18')], [link(1, 2, 2)], 1);
  assert.equal(lag.get(2)?.startDate, '2026-10-27');
  const lead = propagate([task(1, '2026-10-18', '2026-10-22'), task(2, '2026-10-18', '2026-10-18')], [link(1, 2, -2)], 1);
  assert.equal(lead.get(2)?.startDate, '2026-10-21');
});

test('work already late enough is not pulled earlier, and the push runs down the chain', () => {
  const tasks = [task(1, '2026-10-18', '2026-10-22'), task(2, '2026-11-08', '2026-11-09'), task(3, '2026-10-01', '2026-10-01')];
  const moved = propagate(tasks, [link(1, 2), link(1, 3), link(3, 2)], 1);
  assert.equal(moved.has(2), false);
  assert.equal(moved.get(3)?.startDate, '2026-10-25');
});
