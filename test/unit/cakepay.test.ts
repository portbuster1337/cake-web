import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAKE_PAY_COUNTRIES, countryFromCode, formatDuration, initialCountry, normalizeCountryName, orderState, parseCard, parseOrder, parseVendor, paymentDataFor, stripHtml } from '../../src/cakepay/models.ts';

const FIATS = ['USD', 'EUR', 'GBP'];

test('countries: Cake Pay excludes the EU and Antarctica; the initial country follows the fiat', () => {
  assert.ok(!CAKE_PAY_COUNTRIES.some((c) => c.countryCode === 'EU' || c.countryCode === 'AQ'));
  assert.equal(CAKE_PAY_COUNTRIES.length, 153);
  assert.equal(initialCountry('eur').countryCode, 'DE');
  assert.equal(initialCountry('gbr').countryCode, 'GB');
  // Cake's table gives Canada the fiat's code "cad"; an unknown code falls back to the USA
  assert.equal(initialCountry('cad').countryCode, 'CA');
  assert.equal(initialCountry('xyz').countryCode, 'US');
  assert.equal(countryFromCode('USA')?.fullName, 'USA');
  assert.equal(normalizeCountryName(' UK '), 'United Kingdom');
  assert.equal(normalizeCountryName('Spain'), 'Spain');
});

test('cards: HTML stripped, the 10 USD minimum, the type, the fiat (USD when unknown)', () => {
  assert.equal(stripHtml('<b>Hi</b>&amp;you'), ' Hi  you');
  const c = parseCard({ id: 7, name: '<p>Shop</p>', type: 'Prepaid Cards', currency_code: 'NIO', min_value: '2.00', min_value_usd: '2.5', max_value: '500', denominations: [{ value: '10', card_id: '8' }, { value: 25, card_id: 9 }] }, FIATS);
  assert.equal(c.name, ' Shop ');
  assert.equal(c.type, 'prepaid');
  assert.equal(c.fiatCurrency, 'USD');
  // 10 USD at 2.00 local per 2.5 USD
  assert.equal(c.minValue, '8.00');
  assert.deepEqual(c.denominations.map((d) => [d.value, d.cardId]), [[10, 8], [25, 9]]);
  assert.equal(parseCard({ id: 1, type: 'GIFT', currency_code: 'EUR', min_value: '5', min_value_usd: '12' }, FIATS).minValue, '5');
  assert.equal(parseCard({ id: 1, type: 'gift', currency_code: 'EUR' }, FIATS).type, 'gift');
});

test('vendors: cards of the vendor country only; all prepaid → one card with every range by minimum', () => {
  const v = parseVendor({ id: 3, name: 'X', available: true, country: 'UK', cards: [
    { id: 11, type: 'Prepaid Cards', country: 'United Kingdom', currency_code: 'GBP', min_value: '50', max_value: '100' },
    { id: 12, type: 'Prepaid Cards', country: 'UK', currency_code: 'GBP', min_value: '10', max_value: '49' },
    { id: 13, type: 'gift', country: 'France', currency_code: 'EUR' },
  ] }, FIATS);
  assert.equal(v.country, 'United Kingdom');
  assert.equal(v.card?.id, 11);
  assert.deepEqual(v.card?.prepaidRange, [{ minValue: 10, maxValue: 49, rangeId: '12' }, { minValue: 50, maxValue: 100, rangeId: '11' }]);
  const g = parseVendor({ id: 4, name: 'Y', available: false, country: 'Spain', cards: [{ id: 20, type: 'gift', country: 'Spain' }, { id: 21, type: 'Prepaid Cards', country: 'Spain' }] }, FIATS);
  assert.equal(g.card?.id, 20);
  assert.equal(g.card?.prepaidRange.length, 0);
  assert.equal(g.available, false);
  assert.equal(parseVendor({ id: 5, name: 'Z', country: 'Spain', cards: [{ id: 30, type: 'gift', country: 'Italy' }] }, FIATS).card, null);
});

test('orders: payment data by method, a BIP21 link gives the address and amount; statuses', () => {
  const o = parseOrder({
    order_id: 'o1', external_id: 'e1', amount_usd: 50, status: 'new', vouchers: null,
    cards: [{ card_id: 5, price: '50.00', quantity: 2, currency_code: 'EUR', subtotal: '100.00', name: 'Shop', card_image_url: 'https://x/y.png' }],
    payment_data: {
      BTC: { price: '0.0015', amount_from: 0.0015, address: 'bc1qold', paymentUrls: { BIP21: 'bitcoin:bc1qnew?amount=0.0016' } },
      XMR: { price: '0.2', amount_from: 1, address: '4abc' },
      ZEC_CHAIN: { price: '1', address: 't1abc' },
      invoice_time: 1000, expiration_time: 901000, commission: 1,
    },
  });
  assert.equal(o.totalReceiveAmount, '100.00');
  assert.equal(o.quantity, 2);
  assert.equal(o.fiatCurrencyCode, 'EUR');
  assert.deepEqual(paymentDataFor('BTC', o), { price: '0.0016', address: 'bc1qnew', amount: '0.0015', paymentUrls: o.paymentData.methods.BTC!.paymentUrls });
  assert.equal(paymentDataFor('XMR', o)?.address, '4abc');
  assert.equal(paymentDataFor('XMR', o)?.amount, '1.0');
  assert.equal(paymentDataFor('ZEC', o)?.address, 't1abc');
  assert.equal(paymentDataFor('LTC', o), null);
  assert.equal(paymentDataFor(null, o), null);
  assert.equal(orderState('new'), 'pending');
  assert.equal(orderState('purchased'), 'confirmed');
  assert.equal(orderState('paid_partial'), 'UNDERPAID');
  assert.equal(orderState('weird'), 'NOT_FOUND');
  assert.equal(formatDuration(3_725_000), '01:02:05');
  assert.equal(formatDuration(59_999), '00:00:59');
});
