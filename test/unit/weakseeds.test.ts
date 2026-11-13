import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isWeakSeed, parseWeakSeeds, seedHash, weakSeedsNotice } from '../../src/app/weakSeeds.ts';

test('weak seeds: the shipped list, looked up by hash, the notice', () => {
  const list = parseWeakSeeds(readFileSync(new URL('../../public/cake/text/cakewallet_weak_bitcoin_seeds_hashed_sorted_version1.txt', import.meta.url), 'utf8'));
  assert.equal(list.size, 8717);
  // the last line, out of the file's order, is found too
  assert.ok([...list].some((h) => h.startsWith('f56599f4353c')));
  assert.ok(!isWeakSeed(list, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'));
  assert.ok(isWeakSeed(new Set([...list, seedHash('weak test seed')]), 'weak test seed'));
  assert.ok(isWeakSeed(new Set([seedHash('a')]), 'a') && !isWeakSeed(new Set(), 'a'));
  assert.equal(seedHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(weakSeedsNotice(['A', 'B']).includes('[A, B]'));
});
