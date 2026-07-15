import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMoveCadence } from '../src/game-engine.js';

test('accepts fast but human-scale move timing', () => {
  assert.doesNotThrow(() => validateMoveCadence([
    1_000, 1_266, 1_710, 2_180, 2_760, 3_420, 4_050, 4_710, 6_480,
  ]));
});

test('accepts the fast human burst from run ae0ef8cb', () => {
  assert.doesNotThrow(() => validateMoveCadence([
    19_095, 19_513, 20_070, 20_511, 21_247, 21_616, 22_388, 23_169, 23_690,
  ]));
});

test('rejects moves closer than 100 milliseconds', () => {
  assert.throws(() => validateMoveCadence([1_000, 1_099]), /too quickly/);
});

test('rejects six-move bursts under one second', () => {
  assert.throws(() => validateMoveCadence([1_000, 1_190, 1_380, 1_570, 1_760, 1_999]), /short burst/);
});

test('still rejects the observed 117 millisecond bot cadence', () => {
  assert.throws(() => validateMoveCadence([1_000, 1_117, 1_234, 1_351, 1_468, 1_585]), /short burst/);
});

test('rejects sustained nine-move bursts under three seconds', () => {
  assert.throws(
    () => validateMoveCadence([1_000, 1_374, 1_748, 2_122, 2_496, 2_870, 3_244, 3_618, 3_992]),
    /Sustained move rate/,
  );
});

test('allows the burst limits at their exact boundaries', () => {
  assert.doesNotThrow(() => validateMoveCadence([
    1_000, 1_200, 1_400, 1_600, 1_800, 2_000, 2_500, 3_200, 4_000,
  ]));
});
