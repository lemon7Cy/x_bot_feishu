import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisWindow, digestWindow } from '../src/time.js';
import { isTimeDue } from '../src/scheduler.js';

const config = {
  timezone: 'Asia/Shanghai',
  digest: { window: 'rolling_prepare_time' },
  scheduler: { prepare: { time: '08:30' } }
};

test('digestWindow uses rolling prepare window', () => {
  const window = digestWindow(config, undefined, new Date('2026-06-18T00:29:00.000Z'));
  assert.equal(window.date, '2026-06-18');
  assert.equal(window.start.toISOString(), '2026-06-17T00:30:00.000Z');
  assert.equal(window.end.toISOString(), '2026-06-18T00:30:00.000Z');
});

test('analysisWindow moves to next report window after prepare cutoff', () => {
  const before = analysisWindow(config, undefined, new Date('2026-06-18T00:29:00.000Z'));
  const after = analysisWindow(config, undefined, new Date('2026-06-18T00:31:00.000Z'));
  assert.equal(before.date, '2026-06-18');
  assert.equal(after.date, '2026-06-19');
  assert.equal(after.start.toISOString(), '2026-06-18T00:30:00.000Z');
});

test('scheduler time due catches missed minute but not early ticks', () => {
  assert.equal(isTimeDue(new Date('2026-06-18T00:29:59.000Z'), 'Asia/Shanghai', '08:30'), false);
  assert.equal(isTimeDue(new Date('2026-06-18T00:30:01.000Z'), 'Asia/Shanghai', '08:30'), true);
  assert.equal(isTimeDue(new Date('2026-06-18T01:05:00.000Z'), 'Asia/Shanghai', '08:30'), true);
});
