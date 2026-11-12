// Payment URIs (cw_core/lib/payment_uris.dart) and PaymentRequest parsing
// (lib/utils/payment_request.dart).

import type { WalletType } from '../coins/types.ts';

export interface ReceiveUriOpts {
  type: WalletType;
  address: string;
  amount?: string;
  chainId?: number;
  /** token contract / mint */
  token?: string;
  tokenDecimals?: number;
}

export function receiveUri(o: ReceiveUriOpts): string {
  const amount = (o.amount ?? '').replace(',', '.').trim();
  const q = (k: string) => (amount ? `?${k}=${amount}` : '');
  switch (o.type) {
    case 'monero':
      return `monero:${o.address}${q('tx_amount')}`;
    case 'wownero':
      return `wownero:${o.address}${q('tx_amount')}`;
    case 'bitcoin':
      return `bitcoin:${o.address}${q('amount')}`;
    case 'litecoin':
      return `litecoin:${o.address}${q('amount')}`;
    case 'bitcoinCash':
      return `${o.address}${q('amount')}`;
    case 'dogecoin':
      return `doge:${o.address}${q('amount')}`;
    case 'decred':
      return `decred:${o.address}${q('amount')}`;
    case 'nano':
      return `nano:${o.address}${q('amount')}`;
    case 'zano':
      return `zano:${o.address}${q('amount')}`;
    case 'zcash':
      return `zcash:${o.address}${q('amount')}`;
    case 'solana': {
      const p: string[] = [];
      if (amount) p.push(`amount=${amount}`);
      if (o.token) p.push(`spl-token=${o.token}`);
      return `solana:${o.address}${p.length ? `?${p.join('&')}` : ''}`;
    }
    case 'tron': {
      const p: string[] = [];
      if (amount) p.push(`amount=${amount}`);
      if (o.token) p.push(`token=${o.token}`);
      return `tron:${o.address}${p.length ? `?${p.join('&')}` : ''}`;
    }
    default: {
      // EVM: EIP-681
      const chain = o.chainId ?? 1;
      if (o.token) {
        const p = [`address=${o.address}`];
        if (amount) {
          if (o.tokenDecimals === 18) p.push(`uint256=${toAtomic(amount, 18)}`);
          p.push(`amount=${amount}`);
        }
        return `ethereum:${o.token}@${chain}/transfer?${p.join('&')}`;
      }
      return `ethereum:${o.address}@${chain}${amount ? `?value=${Number(amount)}e18` : ''}`;
    }
  }
}

function toAtomic(amount: string, decimals: number): string {
  const [w, f = ''] = amount.split('.');
  return (BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

export interface PaymentRequest {
  address: string;
  amount: string;
  note: string;
  scheme: string;
  pjUri?: string;
  /** EVM chain id (only when the URI had @chainId) */
  chainId?: number;
  /** token contract (EVM transfer / tron token / solana spl-token) */
  contract?: string;
  rawTokenAmount?: string;
  callback?: string;
}

/** BOLT11 amount in sats (cw_core/lib/lnurl.dart) */
export function bolt11Amount(inv: string): number | null {
  const m = /^(lnbcrt|lntbs|lnbc|lntb)(\d+)([munp]?)1/i.exec(inv);
  if (!m) return null;
  const n = BigInt(m[2]);
  const mult = m[3].toLowerCase();
  let msat: bigint;
  switch (mult) {
    case 'm':
      msat = n * 100_000_000n;
      break;
    case 'u':
      msat = n * 100_000n;
      break;
    case 'n':
      msat = n * 100n;
      break;
    case 'p':
      if (n % 10n) return null;
      msat = n / 10n;
      break;
    default:
      msat = n * 100_000_000_000n;
  }
  return msat % 1000n === 0n ? Number(msat / 1000n) : null;
}

export function parsePaymentRequest(input: string): PaymentRequest {
  const s = input.trim();
  if (/^(lightning:)?(lnbc|lntb|lnbs|lnbcrt)[a-z0-9]+$/i.test(s)) {
    const inv = s.replace(/^lightning:/i, '');
    const sats = bolt11Amount(inv);
    return { address: inv, amount: sats ? (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') : '', note: '', scheme: 'lightning' };
  }
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(s);
  if (!m || /^https?$/i.test(m[1]) || s.length < 10) return { address: s, amount: '', note: '', scheme: '' };
  const scheme = m[1].toLowerCase();
  let rest = m[2].replace(/^\/\//, '');
  const qi = rest.indexOf('?');
  const path = qi >= 0 ? rest.slice(0, qi) : rest;
  const params = new URLSearchParams(qi >= 0 ? rest.slice(qi + 1) : '');
  const out: PaymentRequest = { address: params.get('address') ?? path, amount: params.get('tx_amount') ?? params.get('amount') ?? '', note: params.get('tx_description') ?? params.get('message') ?? '', scheme, callback: params.get('callback') ?? undefined };
  if (params.get('pj')) out.pjUri = s;
  if (scheme === 'ethereum') {
    let p = path.replace(/^pay-/, '');
    const target = /^(0x)?[0-9a-f]{40}/i.exec(p)?.[0] ?? p.split(/[@/]/)[0];
    const at = /@(\d+)/.exec(p);
    if (at) out.chainId = Number(at[1]);
    if (p.includes('/')) {
      out.contract = target;
      out.address = params.get('address') ?? '';
      out.amount = params.get('amount') ?? '';
      const u = params.get('uint256');
      if (u) {
        if (u.includes('.') && !/e/i.test(u) && !out.amount) out.amount = u;
        else out.rawTokenAmount = normalizeSci(u);
      }
    } else {
      out.address = target;
      const v = params.get('value');
      if (v) out.amount = weiToEth(v);
    }
  } else if (scheme === 'tron') {
    out.contract = params.get('token') ?? undefined;
  } else if (scheme === 'solana') {
    out.contract = params.get('spl-token') ?? undefined;
  } else if (scheme === 'nano-gpt') {
    out.scheme = params.get('type') ?? 'nano';
  }
  if ((out.scheme === 'nano' || out.address.startsWith('nano_')) && out.amount && !out.amount.includes('.') && out.amount.length > 9) {
    out.amount = (Number(BigInt(out.amount) / 10n ** 21n) / 1e9).toString();
  }
  return out;
}

function normalizeSci(v: string): string {
  if (/e/i.test(v)) {
    const [mant, exp] = v.toLowerCase().split('e');
    const [w, f = ''] = mant.split('.');
    const e = Number(exp);
    return (w + f.padEnd(e, '0').slice(0, e) + '').replace(/^0+(?=\d)/, '');
  }
  return v.split('.')[0];
}

function weiToEth(v: string): string {
  if (v.includes('.') && !/e/i.test(v)) return v;
  const wei = BigInt(normalizeSci(v));
  const w = wei / 10n ** 18n;
  const f = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}
