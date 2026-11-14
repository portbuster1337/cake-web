import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignedPoints, changeData, gridPrice, initAssets, insertAsset, priceMoney, rangeStart, removeAsset, scrubPrice, scrubTime, sortAssets, toStringWithPrecision, type ChangeData } from '../../src/app/chartsModel.ts';
import { withLocalSeparator } from '../../src/core/amount.ts';

const fmt = (price: number, decimals: number, trimZeros = true) => toStringWithPrecision(priceMoney(price, decimals), decimals, { fractionalDigits: 2, trimZeros, meaningfulDecimals: 2 });

test('charts: prices as Cake\'s Money prints them (toStringAsFixed(20), then two decimals or two meaningful digits)', () => {
  assert.equal(fmt(65432.12, 8), '65432.12');
  // 65432.1 is the double 65432.0999…: cut, not rounded, as in Cake
  assert.equal(fmt(65432.1, 8), '65432.09');
  assert.equal(fmt(65432.5, 8), '65432.5');
  assert.equal(fmt(65432.5, 8, false), '65432.50');
  assert.equal(fmt(65432.129, 8), '65432.12');
  assert.equal(fmt(1, 8, false), '1.00');
  assert.equal(fmt(1, 8), '1');
  assert.equal(fmt(0.5, 12, false), '0.50');
  assert.equal(fmt(0.052345, 8), '0.052');
  assert.equal(fmt(0.000012345, 18), '0.000012');
  assert.equal(fmt(0, 8), '0');
  // the price under the finger: whole prices without decimals
  assert.equal(scrubPrice(priceMoney(100, 8), 8), '100');
  assert.equal(scrubPrice(priceMoney(100.5, 8), 8), '100.50');
  // the grid: no decimals above 10 000 (rounded), the price below 1, else two decimals
  assert.equal(gridPrice('65432.56'), '65433');
  assert.equal(gridPrice('123.40'), '123.40');
  assert.equal(gridPrice('0.052'), '0.052');
  assert.equal(gridPrice('...'), '...');
});

test('charts: withLocalSeperator groups by threes with the language\'s separators', () => {
  assert.equal(withLocalSeparator('65432'), '65,432');
  assert.equal(withLocalSeparator('1234567.89', 'en'), '1,234,567.89');
  assert.equal(withLocalSeparator('1234567.89', 'de'), '1.234.567,89');
  // NumberFormat("#,###") groups four digits too (Intl's Spanish would not)
  assert.equal(withLocalSeparator('1234.5', 'es'), '1.234,5');
  assert.equal(withLocalSeparator('0.052', 'en'), '0.052');
  assert.equal(withLocalSeparator('999', 'en'), '999');
  assert.equal(withLocalSeparator('< 0.01', 'en'), '< 0.01');
  assert.equal(withLocalSeparator('1234 USD', 'en'), '1,234 USD');
  assert.equal(withLocalSeparator('1234.5', 'pt_BR'), '1.234,5');
});

test('charts: change data of a range (last against first), Cake\'s zero without data', () => {
  const up = changeData([[0, 100], [3600, 110]], 8);
  assert.deepEqual([up.up, up.percentage, toStringWithPrecision(up.amount, 8, { fractionalDigits: 2, meaningfulDecimals: 2 })], [true, '10.00', '10']);
  const down = changeData([[0, 110], [3600, 99]], 8);
  assert.deepEqual([down.up, down.percentage, toStringWithPrecision(down.amount, 8, { fractionalDigits: 2, meaningfulDecimals: 2 })], [false, '10.00', '11']);
  const none = changeData([], 8);
  assert.deepEqual([none.up, none.percentage, none.amount.amount, none.amountDecimals], [true, '0.00', 0n, 2]);
  const same = changeData([[0, 5], [1, 5]], 8);
  assert.deepEqual([same.up, same.percentage], [true, '0.00']);
});

test('charts: ranges, aligned points, scrub time', () => {
  assert.equal(rangeStart('1D', 1_000_000), Math.floor((1_000_000 - 86400) / 900) * 900);
  assert.equal(rangeStart('ALL', 1_000_000), 0);
  assert.deepEqual(alignedPoints([[1800, 2], [900, 1], [1000, 9]], '1D'), [[900, 1], [1800, 2]]);
  assert.equal(scrubTime(new Date(2026, 0, 5, 7, 3).getTime() / 1000), '1/5/2026 07:03');
  assert.equal(scrubTime(new Date(2026, 10, 14, 23, 59).getTime() / 1000), '11/14/2026 23:59');
});

test('charts: Cake\'s sorts (market cap, then full names; gains and losses by signed change; full names by code unit)', () => {
  const a = (key: string, fullName: string | null, title = key.toUpperCase()) => ({ key, title, fullName });
  const list = [a('xmr', 'Monero'), a('ada', 'Cardano'), a('btc', 'Bitcoin'), a('zzz', null, 'AAA'), a('eth', 'Ethereum')];
  const ch = new Map<string, ChangeData>([
    ['xmr', { up: true, percentage: '5.00', amount: { amount: 0n, decimals: 2 }, amountDecimals: 2 }],
    ['ada', { up: false, percentage: '7.00', amount: { amount: 0n, decimals: 2 }, amountDecimals: 2 }],
    ['btc', { up: true, percentage: '1.00', amount: { amount: 0n, decimals: 2 }, amountDecimals: 2 }],
    ['zzz', { up: false, percentage: '0.00', amount: { amount: 0n, decimals: 2 }, amountDecimals: 2 }],
    ['eth', { up: true, percentage: '0.00', amount: { amount: 0n, decimals: 2 }, amountDecimals: 2 }],
  ]);
  const keys = (c: Parameters<typeof sortAssets>[1]) => sortAssets(list, c, (x) => ch.get(x.key)!).map((x) => x.key).join(',');
  assert.equal(keys('marketcap'), 'btc,eth,xmr,zzz,ada');
  assert.equal(keys('alphabetical'), 'zzz,btc,ada,eth,xmr');
  // a fall of 0.00 % comes before a rise of 0.00 % (double.compareTo)
  assert.equal(keys('gains'), 'xmr,btc,eth,zzz,ada');
  assert.equal(keys('losses'), 'ada,zzz,eth,btc,xmr');
});

test('charts: the followed-assets table (insert-or-replace moves a row to the end; the first pinned when none is)', () => {
  const rows = [{ api: 'crypto.BTC', fav: true }, { api: 'crypto.XMR', fav: false }, { api: 'crypto.ETH', fav: false }];
  // pinning Monero: Bitcoin then Monero written again
  const pinned = insertAsset(insertAsset(rows, 'crypto.BTC', false), 'crypto.XMR', true);
  assert.deepEqual(pinned.map((r) => `${r.api}:${r.fav}`), ['crypto.ETH:false', 'crypto.BTC:false', 'crypto.XMR:true']);
  assert.deepEqual(removeAsset(rows, 'crypto.XMR').map((r) => r.api), ['crypto.BTC', 'crypto.ETH']);
  const empty = initAssets([]);
  assert.deepEqual([empty.assets, empty.pinned, empty.rows], [['crypto.BTC'], 'crypto.BTC', [{ api: 'crypto.BTC', fav: true }]]);
  // none pinned: the first is, and its row moves to the end (the session keeps it first)
  const none = initAssets([{ api: 'crypto.LTC', fav: false }, { api: 'crypto.XMR', fav: false }]);
  assert.deepEqual([none.assets, none.pinned, none.rows.map((r) => `${r.api}:${r.fav}`)], [['crypto.LTC', 'crypto.XMR'], 'crypto.LTC', ['crypto.XMR:false', 'crypto.LTC:true']]);
  const ok = initAssets(pinned);
  assert.deepEqual([ok.assets, ok.pinned, ok.rows], [['crypto.ETH', 'crypto.BTC', 'crypto.XMR'], 'crypto.XMR', pinned]);
});
