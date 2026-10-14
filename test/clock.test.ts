import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoryClock, spokenTime } from '../src/clock.js';

test('the story clock stands still until a step moves it', () => {
  const c = new StoryClock('2026-10-14T06:10:00Z', 'X-Story-Time');
  assert.ok(c.frozen);
  assert.equal(c.now().toISOString(), '2026-10-14T06:10:00.000Z');
  assert.equal(c.move('+2h').toISOString(), '2026-10-14T08:10:00.000Z');
  assert.equal(c.move('+1h30m').toISOString(), '2026-10-14T09:40:00.000Z');
  assert.equal(c.move('+1d').toISOString(), '2026-10-15T09:40:00.000Z');
  assert.equal(c.move('2026-10-16T00:00:00Z').toISOString(), '2026-10-16T00:00:00.000Z');
  assert.deepEqual(c.headers(), { 'X-Story-Time': '2026-10-16T00:00:00.000Z' });
  assert.throws(() => c.move('2026-10-15T00:00:00Z'), /only moves forward/);
  assert.throws(() => c.move('soon'), /neither/);
});

test('without a start, it is the real time and cannot move', () => {
  const c = new StoryClock();
  assert.ok(!c.frozen);
  assert.deepEqual(c.headers(), {});
  assert.ok(Math.abs(c.now().getTime() - Date.now()) < 1000);
  assert.throws(() => c.move('+1h'), /no clock/);
});

test('spoken time is in the household zone', () => {
  const at = new Date('2026-10-14T06:10:00Z');
  assert.equal(spokenTime(at, 'Africa/Lagos'), 'Wednesday, October 14, 2026 at 7:10 AM');
  assert.equal(spokenTime(at, 'UTC'), 'Wednesday, October 14, 2026 at 6:10 AM');
});
