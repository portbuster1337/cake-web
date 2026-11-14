import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLnurl, isOpenCryptoPayQR, ocpMethod, requiresClientCommit, withAmount } from '../../src/integrations/openCryptoPay.ts';

test('Open CryptoPay: QRs, LNURLs (LUD-01 vector, LUD-17 schemes), methods, who broadcasts', () => {
  const lnurl = 'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS';
  assert.equal(decodeLnurl(lnurl).href, 'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df');
  assert.equal(decodeLnurl(`lightning:${lnurl}`).host, 'service.com');
  assert.equal(decodeLnurl('lnurlp://pay.example.com/lnurl/abc?x=1').href, 'https://pay.example.com/lnurl/abc?x=1');
  assert.equal(decodeLnurl('lnurlp://abcdefghijklmnop.onion/pay').protocol, 'http:');
  assert.throws(() => decodeLnurl('hello'), /lnurl/);
  assert.ok(isOpenCryptoPayQR(`https://app.dfx.swiss/pl/?lightning=${lnurl}`));
  assert.ok(isOpenCryptoPayQR(lnurl));
  assert.ok(!isOpenCryptoPayQR('bitcoin:bc1q...'));
  assert.equal(ocpMethod({ title: 'USDT', tag: 'POL', fullName: 'Tether' }), 'Polygon');
  assert.equal(ocpMethod({ title: 'BTC', tag: null, fullName: 'Bitcoin' }), 'Bitcoin');
  assert.equal(ocpMethod({ title: 'ETH', tag: null, fullName: 'Ethereum', key: 'eth' }), 'Ethereum');
  assert.ok(requiresClientCommit({ title: 'XMR', tag: null, fullName: 'Monero', key: 'xmr' }));
  assert.ok(requiresClientCommit({ title: 'USDC', tag: 'SOL', fullName: 'USD Coin' }));
  assert.ok(!requiresClientCommit({ title: 'BTC', tag: null, fullName: 'Bitcoin', key: 'btc' }));
  // the merchant's URI keeps its amount, else gets the invoice's (and loses an @chain)
  assert.equal(withAmount('bitcoin:bc1qxyz?amount=0.1', '0.2'), 'bitcoin:bc1qxyz?amount=0.1');
  assert.equal(withAmount('ethereum:0xabc@1?label=x', '0.5'), 'ethereum:0xabc?label=x&amount=0.5');
  assert.equal(withAmount('monero:4abc', '1.25'), 'monero:4abc?amount=1.25');
});
