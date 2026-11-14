// Open CryptoPay (lib/core/open_crypto_pay/*): paying a merchant's LNURL invoice in another coin.
// The invoice lists the coins it takes; the merchant's callback gives this coin's address and
// amount; once signed, the transaction goes back to the merchant (who broadcasts it, unless the
// coin needs the wallet to: Monero, Zano, Solana). Over Tor like every request.

import { bech32 } from '@scure/base';
import { request } from '../net/http.ts';

/** OpenCryptoPayService.isOpenCryptoPayQR */
export const isOpenCryptoPayQR = (v: string) => v.toLowerCase().includes('lightning=lnurl') || v.toLowerCase().startsWith('lnurl');

/** OpenCryptoPayException / OpenCryptoPayNotSupportedException ("<host> does not support Open CryptoPay") */
export class OpenCryptoPayError extends Error {}
export class OpenCryptoPayNotSupported extends OpenCryptoPayError {
  constructor(provider: string) {
    super(`${provider} does not support Open CryptoPay`);
  }
}

/** the coin as Cake describes it: its title, tag and full name */
export interface OcpAsset {
  title: string;
  tag: string | null;
  fullName: string | null;
  /** a currency key (native coins) */
  key?: string;
}

/** requiresClientCommit: coins whose transaction the wallet broadcasts itself */
export const requiresClientCommit = (a: OcpAsset) => a.key === 'xmr' || a.key === 'zano' || a.key === 'sol' || a.tag === 'SOL';

/** _getMethod */
export function ocpMethod(a: OcpAsset): string {
  switch (a.tag) {
    case 'ETH':
      return 'Ethereum';
    case 'POL':
      return 'Polygon';
    case 'ARB':
      return 'Arbitrum';
    case 'TRX':
      return 'Tron';
    case 'SOL':
      return 'Solana';
    default:
      return a.fullName ?? a.title;
  }
}

const LUD17 = ['lnurlw', 'lnurlc', 'lnurlp', 'keyauth'];

/** LNURL.decode: LUD-17 scheme URLs as they are (http for onions), else the one bech32 "lnurl1…" in the text */
export function decodeLnurl(input: string): URL {
  const s = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  const prefix = scheme ? LUD17.find((p) => scheme.includes(p)) : undefined;
  if (prefix) {
    const u = new URL(`https:${s.slice(scheme!.length + 1)}`);
    return new URL(`${u.hostname.endsWith('onion') || u.hostname.endsWith('onion.') ? 'http' : 'https'}://${u.host}${u.pathname}${u.search}`);
  }
  const found = [...s.toLowerCase().matchAll(/,*?((lnurl)([0-9]+[a-z0-9]+))/g)];
  if (found.length !== 1) throw new Error('Not a valid lnurl string');
  const { words } = bech32.decode(found[0][0].replace(/^,+/, ''), false);
  return new URL(new TextDecoder().decode(bech32.fromWords(words)));
}

export interface OcpQuoteAsset {
  symbol: string;
  amount: string;
}

/** OpenCryptoPayRequest */
export interface OcpRequest {
  receiverName: string;
  /** seconds left */
  expiry: number;
  callbackUrl: string;
  quote: string;
  methods: Record<string, OcpQuoteAsset[]>;
}

/** getOpenCryptoPayInvoice: the invoice behind the QR (an https link's lightning parameter, or the LNURL itself) */
export async function getOcpInvoice(input: string, scope: string): Promise<OcpRequest> {
  let lnurl = input.trim();
  if (lnurl.toLowerCase().startsWith('http')) {
    const u = new URL(lnurl);
    const l = u.searchParams.get('lightning');
    if (!l) throw new OpenCryptoPayNotSupported(u.host);
    lnurl = l;
  }
  const url = decodeLnurl(lnurl);
  const res = await request(url.href, undefined, { scope, timeoutMs: 45_000, okStatuses: [400, 404, 500], purpose: 'Open CryptoPay invoice' });
  const body = new TextDecoder().decode(res.body);
  if (res.status !== 200) throw new OpenCryptoPayError(`Failed to get Open CryptoPay Request. Status: ${res.status} ${body}`);
  const j = JSON.parse(body);
  for (const k of ['callback', 'transferAmounts', 'quote']) if (!(k in j)) throw new OpenCryptoPayNotSupported(url.host);
  const methods: Record<string, OcpQuoteAsset[]> = {};
  for (const ta of j.transferAmounts as { method: string; assets: { asset: string; amount: string }[] }[]) {
    methods[ta.method] = (ta.assets ?? []).map((a) => ({ symbol: a.asset, amount: a.amount }));
  }
  return {
    receiverName: j.displayName ?? 'Unknown',
    expiry: Math.round((Date.parse(j.quote.expiration) - Date.now()) / 1000),
    callbackUrl: j.callback,
    quote: j.quote.id,
    methods,
  };
}

const withParams = (base: string, params: Record<string, string>) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return `https://${u.host}${u.pathname}${u.search}`;
};

/** _getAmountByAsset */
function amountOf(r: OcpRequest, a: OcpAsset): string | undefined {
  return r.methods[ocpMethod(a)]?.find((x) => x.symbol.toUpperCase() === a.title.toUpperCase())?.amount;
}

/** getOpenCryptoPayAddress: the payment URI for this coin (its amount added when the merchant left it out) */
export async function getOcpAddress(r: OcpRequest, a: OcpAsset, scope: string): Promise<string> {
  const url = withParams(r.callbackUrl, { quote: r.quote, asset: a.title, method: ocpMethod(a) });
  const res = await request(url, undefined, { scope, timeoutMs: 45_000, okStatuses: [400, 404, 500], purpose: 'Open CryptoPay address' });
  const body = new TextDecoder().decode(res.body);
  if (res.status !== 200) throw new OpenCryptoPayError(`Failed to create Open CryptoPay Request. Status: ${res.status} ${body}`);
  const j = JSON.parse(body);
  if (!('expiryDate' in j) || !('uri' in j)) throw new OpenCryptoPayNotSupported(new URL(r.callbackUrl).host);
  return withAmount(String(j.uri), amountOf(r, a));
}

/** the merchant's URI, with the invoice's amount for the coin when it has none (and no @chain in the path) */
export function withAmount(uri: string, amount: string | undefined): string {
  if (/[?&]amount=/.test(uri)) return uri;
  const m = /^([^:]+):([^?]*)(?:\?(.*))?$/.exec(uri);
  if (!m) return uri;
  const params = new URLSearchParams(m[3] ?? '');
  if (amount) params.set('amount', amount);
  return `${m[1]}:${m[2].split('@')[0]}?${params}`;
}

/** commitOpenCryptoPayRequest: the signed transaction to the merchant; its id back */
export async function commitOcp(r: OcpRequest, a: OcpAsset, txId: string, hex: string, scope: string): Promise<string> {
  const params: Record<string, string> = { quote: r.quote, asset: a.title, method: ocpMethod(a), tx: txId };
  if (hex) params.hex = hex;
  const res = await request(withParams(r.callbackUrl.replace('/cb/', '/tx/'), params), undefined, { scope, timeoutMs: 60_000, okStatuses: [400, 404, 500], purpose: 'Open CryptoPay payment' });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(new TextDecoder().decode(res.body));
  } catch { /* not JSON */ }
  if (res.status === 200) {
    if (typeof body.txId === 'string') return body.txId;
    throw new OpenCryptoPayError(JSON.stringify(body));
  }
  throw new OpenCryptoPayError(`${res.status}: ${body.message ?? ''}`);
}

/** cancelOpenCryptoPayRequest */
export async function cancelOcp(r: OcpRequest, scope: string): Promise<void> {
  await request(r.callbackUrl.replace('/cb/', '/cancel/'), undefined, { method: 'DELETE', scope, timeoutMs: 30_000, retries: 0, okStatuses: [400, 404, 500], purpose: 'Open CryptoPay cancel' }).catch(() => {});
}
