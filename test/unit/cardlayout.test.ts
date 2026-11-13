import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideCard, moveCard, resolveCardLayout, unhideCard } from '../../src/app/cardLayout.ts';

test('card layout: stored order first, new accounts after by index, archived apart', () => {
  assert.deepEqual(resolveCardLayout([0, 1, 2], undefined), { visible: [0, 1, 2], hidden: [] });
  assert.deepEqual(resolveCardLayout([0, 1, 2, 3], { order: [2, 0], hidden: [1] }), { visible: [2, 0, 3], hidden: [1] });
  // stored positions of accounts that no longer exist are ignored; duplicates collapse
  assert.deepEqual(resolveCardLayout([0, 0, 1], { order: [9, 1, 0], hidden: [9] }), { visible: [1, 0], hidden: [] });
  assert.deepEqual(resolveCardLayout([0, 1, 2], { hidden: [2, 0] }), { visible: [1], hidden: [0, 2] });
});

test('card moves, archiving and bringing back', () => {
  assert.deepEqual(moveCard([0, 1, 2, 3], 1, 4), [0, 2, 3, 1]);
  assert.deepEqual(moveCard([0, 1, 2, 3], 3, 0), [3, 0, 1, 2]);
  assert.deepEqual(moveCard([0, 1, 2], 0, 1), [1, 0, 2]);
  const l = hideCard({ visible: [2, 0, 1], hidden: [3] }, 0);
  assert.deepEqual(l, { visible: [2, 1], hidden: [0, 3] });
  assert.deepEqual(unhideCard(l, 3), { visible: [2, 1, 3], hidden: [0] });
  assert.equal(unhideCard(l, 7), l);
  assert.equal(hideCard(l, 0), l);
});
