import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromJstParts, toJstParts, parseJstLocalInput, toJstLocalInput,
  jstDateKey, jstMonthKey, jstMonthRange, formatJst,
} from '../../src/domain/time.ts';

test('JST壁時計とUTC瞬間を往復できる', () => {
  const instant = fromJstParts({ year: 2026, month: 4, day: 1, hour: 9, minute: 30 });
  assert.equal(instant.toISOString(), '2026-04-01T00:30:00.000Z');
  assert.deepEqual(toJstParts(instant), { year: 2026, month: 4, day: 1, hour: 9, minute: 30 });
});

test('JSTの日付境界はUTCの前日15:00', () => {
  assert.equal(jstDateKey(new Date('2026-04-01T14:59:59Z')), '2026-04-01');
  assert.equal(jstDateKey(new Date('2026-04-01T15:00:00Z')), '2026-04-02');
});

test('datetime-local入力(JST)を解釈する', () => {
  assert.equal(parseJstLocalInput('2026-04-01T09:30').toISOString(), '2026-04-01T00:30:00.000Z');
  assert.equal(toJstLocalInput(new Date('2026-04-01T00:30:00.000Z')), '2026-04-01T09:30');
});

test('存在しない日付を弾く', () => {
  assert.throws(() => parseJstLocalInput('2026-02-30T09:00'), RangeError);
  assert.throws(() => parseJstLocalInput('2026-13-01T09:00'), RangeError);
  assert.throws(() => parseJstLocalInput('2026-04-01 09:00'), RangeError);
});

test('JST月の範囲はUTCで前月末15:00から', () => {
  assert.equal(jstMonthKey(new Date('2026-03-31T15:00:00Z')), '2026-04');
  const range = jstMonthRange('2026-04');
  assert.equal(range.startUtc.toISOString(), '2026-03-31T15:00:00.000Z');
  assert.equal(range.endUtcExclusive.toISOString(), '2026-04-30T15:00:00.000Z');
  assert.equal(jstMonthRange('2026-12').endUtcExclusive.toISOString(), '2026-12-31T15:00:00.000Z');
  assert.throws(() => jstMonthRange('2026-13'), RangeError);
});

test('表示はJSTであることを明示する', () => {
  assert.equal(formatJst(new Date('2026-04-01T00:30:00Z')), '2026/04/01 09:30 JST');
  assert.equal(formatJst(null), '—');
});
