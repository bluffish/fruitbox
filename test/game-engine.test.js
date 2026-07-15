import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMoveCadence } from '../src/game-engine.js';

test('accepts fast but human-scale move timing', () => {
  assert.doesNotThrow(() => validateMoveCadence([
    1_000, 1_266, 1_710, 2_180, 2_760, 3_420, 4_050, 4_710, 6_480,
  ]));
});

test('rejects moves closer than 220 milliseconds', () => {
  assert.throws(() => validateMoveCadence([1_000, 1_219]), /too quickly/);
});

test('rejects six-move bursts under two seconds', () => {
  assert.throws(() => validateMoveCadence([1_000, 1_400, 1_800, 2_200, 2_600, 2_999]), /short burst/);
});

test('rejects sustained nine-move bursts under five seconds', () => {
  assert.throws(
    () => validateMoveCadence([1_000, 1_625, 2_250, 2_875, 3_500, 4_125, 4_750, 5_375, 5_999]),
    /Sustained move rate/,
  );
});

test('allows the burst limits at their exact boundaries', () => {
  assert.doesNotThrow(() => validateMoveCadence([
    1_000, 1_400, 1_800, 2_200, 2_600, 3_000, 3_625, 4_375, 6_000,
  ]));
});
