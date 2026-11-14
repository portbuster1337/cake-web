import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearSyncHistory, etaText, formatEta, noteSyncing, resetSyncStart, showBlocksRemaining } from '../../src/core/syncEta.ts';

test('sync ETA: Cake\'s format, the first 15 seconds, the weighted rate, the placeholder and the smoothing', () => {
  assert.equal(formatEta(45_000), '45s');
  assert.equal(formatEta(125_000), '2min 5s');
  assert.equal(formatEta(3_725_000), '1h 2min 5s');
  assert.equal(formatEta(0), '0s');
  // too little data: the placeholder
  clearSyncHistory();
  resetSyncStart();
  assert.equal(etaText(5000), 'Syncing...');
  noteSyncing(10_000, 0);
  noteSyncing(9_000, 1_000);
  assert.ok(showBlocksRemaining(14_999));
  assert.ok(!showBlocksRemaining(15_000));
  assert.equal(etaText(9_000), 'Syncing...');
  // a block per ms: 8000 blocks are 8 s away
  noteSyncing(8_000, 2_000);
  assert.equal(etaText(8_000), '8s');
  // under 100 blocks, or a day or more away: the placeholder
  assert.equal(etaText(99), 'Syncing...');
  assert.equal(etaText(100_000_000), 'Syncing...');
  // a jump of more than a minute moves by 30 s at most (smoothing from the last ETA, 8 s)
  assert.equal(etaText(90_000), '38s');
  // no progress at all: two days away
  clearSyncHistory();
  noteSyncing(5000, 0);
  noteSyncing(5000, 1000);
  noteSyncing(5000, 2000);
  assert.equal(etaText(5000), 'Syncing...');
  // a new sync starts its 15 seconds again
  resetSyncStart();
  noteSyncing(4000, 100_000);
  assert.ok(showBlocksRemaining(110_000));
});
