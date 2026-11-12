// AddressValidator (lib/core/address_validator.dart): per-currency regex +
// length rules, wrapped as (^|\s)(pattern)($|\s), plus full decoding for
// BTC/LTC (and the other coins we can decode natively).

import type { Currency } from '../coins/types.ts';
import { NETWORKS, isValidAddress as utxoValid } from '../coins/utxo/networks.ts';

const B58 = '[a-km-zA-HJ-NP-Z1-9]';
const BECH = '[ac-hj-np-z02-9]';

function pattern(c: Currency): string | null {
  const key = c.key;
  const evm = '0x[0-9a-zA-Z]+';
  switch (key) {
    case 'xmr':
      return '4[0-9a-zA-Z]{94}|8[0-9a-zA-Z]{94}|[0-9a-zA-Z]{106}';
    case 'ada':
      return '[0-9a-zA-Z]{59}|[0-9a-zA-Z]{92}|[0-9a-zA-Z]{104}|[0-9a-zA-Z]{105}|addr1[0-9a-zA-Z]{98}';
    case 'btc':
      return `(^|s)(1${B58}{25,34})|(3${B58}{25,34})|(bc1q${BECH}{25,39})|(bc1p(${BECH}{39}|${BECH}{59}|${BECH}{8,89}))|(bc1q${BECH}{40,80})|(lightning:)?(lnbc|lntb|lnbs|lnbcrt|lnurl)[a-z0-9]+|(sp1[0-9a-zA-Z]{113})($|s)`;
    case 'ltc':
      return `(^|s)(L${B58}{25,34})|([3M]${B58}{25,34})|(ltc1q${BECH}{25,39})|(ltc1p(${BECH}{39}|${BECH}{59}|${BECH}{8,89}))|(ltc1q${BECH}{40,80})|((ltc|t)mweb1q${BECH}{90,120})($|s)`;
    case 'nano':
    case 'banano':
      return '[0-9a-zA-Z_]+';
    case 'xrp':
      return '[0-9a-zA-Z]{34}|[0-9a-zA-Z]{33}|X[0-9a-zA-Z]{46}';
    case 'xhv':
      return 'hvx|hvi|hvs[0-9a-zA-Z]+';
    case 'bch':
      return `(?:bitcoincash:)?(q|p)[0-9a-zA-Z]{41}|[13]${B58}{25,34}`;
    case 'hbar':
      return '[0-9a-zA-Z.]+';
    case 'zec':
      return '(?:t1[0-9A-Za-z]{33}|t3[0-9A-Za-z]{33}|zs[a-z0-9]{76}|u1[a-z0-9]{1,300}|zxviews[a-z0-9]{278})';
    case 'dcr':
      return '(D|T|S)[ksecS]([0-9a-zA-Z])+';
    case 'rvn':
      return '[Rr]([1-9a-km-zA-HJ-NP-Z]){33}';
    case 'near':
      return '[0-9a-f]{64}';
    case 'rune':
      return 'thor1[0-9a-z]{38}';
    case 'scrt':
      return 'secret1[0-9a-z]{38}';
    case 'stx':
      return 'S[MP][0-9a-zA-Z]+';
    case 'kmd':
      return 'R[0-9a-zA-Z]{33}';
    case 'pivx':
      return 'D([1-9a-km-zA-HJ-NP-Z]){33}';
    case 'btcln':
      return '(lightning:)?(lnbc|lntb|lnbs|lnbcrt|lnurl|LNBC|LNTB|LNBS|LNBCRT|LNURL)[a-zA-Z0-9]+';
    case 'zano':
      return '([1-9A-HJ-NP-Za-km-z]{90,200})|(@[\\w\\d.-]+)';
    case 'doge':
      return `^D${B58}{25,34}`;
    case 'usdt':
    case 'usdterc20':
    case 'xlm':
    case 'trx':
    case 'dai':
    case 'dash':
    case 'eos':
    case 'wow':
    case 'xag': case 'xau': case 'xaud': case 'xbtc': case 'xcad': case 'xchf': case 'xcny': case 'xeur': case 'xgbp': case 'xjpy': case 'xnok': case 'xnzd': case 'xusd':
      return '[0-9a-zA-Z]+';
    case 'eth': case 'baseEth': case 'arbEth': case 'robEth': case 'maticpoly': case 'matic': case 'usdc': case 'usdcpoly': case 'usdtPoly': case 'usdcEPoly': case 'ape': case 'avaxc':
    case 'mana': case 'mkr': case 'oxt': case 'paxg': case 'uni': case 'aave': case 'bat': case 'comp': case 'cro': case 'ens': case 'ftm': case 'frax': case 'gusd': case 'gtc':
    case 'grt': case 'ldo': case 'nexo': case 'pepe': case 'storj': case 'tusd': case 'wbtc': case 'weth': case 'zrx': case 'dydx': case 'steth': case 'shib':
      return evm;
    default:
      return '';
  }
}

function lengths(c: Currency): number[] | null {
  const k = c.key;
  if (['eth', 'baseEth', 'arbEth', 'robEth', 'maticpoly', 'bnb', 'usdc', 'usdcpoly', 'usdtPoly', 'usdcEPoly', 'ape', 'mana', 'matic', 'mkr', 'oxt', 'paxg', 'uni', 'aave', 'bat', 'comp', 'cro', 'ens', 'ftm', 'frax', 'gusd', 'gtc', 'grt', 'ldo', 'nexo', 'pepe', 'storj', 'tusd', 'wbtc', 'weth', 'zrx', 'dydx', 'steth', 'shib', 'eos'].includes(k)) return [42];
  if (['sol', 'usdtSol', 'usdcsol'].includes(k)) return Array.from({ length: 13 }, (_, i) => 32 + i);
  if (k === 'dash') return [34];
  if (k === 'bch') return [42, 54, ...Array.from({ length: 10 }, (_, i) => 26 + i)];
  if (k === 'nano' || k === 'banano') return [64, 65];
  if (k === 'sc') return [76];
  if (['trx', 'usdt', 'usdttrc20'].includes(k)) return [34];
  if (k === 'xlm') return [56];
  if (['btt', 'bttc', 'doge', 'firo', 'xvg', 'kmd', 'pivx', 'rvn'].includes(k)) return [34];
  if (k === 'hbar') return Array.from({ length: 8 }, (_, i) => 4 + i);
  if (k === 'zen') return [35];
  if (k === 'dcr') return [35];
  if (k === 'stx') return [40, 41, 42];
  if (k === 'rune') return [43];
  if (k === 'scrt') return [45];
  if (k === 'near') return [64];
  return null;
}

/** Tokens (by tag) follow their chain's address format. */
function tokenChainKey(c: Currency): string | null {
  if (!c.tag) return null;
  if (['ETH', 'POL', 'BSC', 'BASE', 'ARB', 'ROB'].includes(c.tag)) return 'evm';
  if (c.tag === 'SOL') return 'sol';
  if (c.tag === 'TRX') return 'trx';
  return null;
}

export function isValidAddressFor(c: Currency, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  // native decoders where we have them (stricter than the regex)
  if (c.key === 'btc' && /^(lightning:)?(lnbc|lntb|lnbs|lnbcrt|lnurl)[a-z0-9]+$/i.test(v)) return true;
  if (c.key === 'btc' && /^sp1[0-9a-zA-Z]{113}$/.test(v)) return true;
  if (c.key === 'btc' || c.key === 'ltc' || c.key === 'doge' || c.key === 'bch') {
    const net = NETWORKS[c.key as 'btc' | 'ltc' | 'doge' | 'bch'];
    if (c.key === 'ltc' && /^(ltc|t)mweb1q[ac-hj-np-z02-9]{90,120}$/.test(v)) return true;
    if (utxoValid(net, v)) return true;
    if (c.key === 'btc' || c.key === 'ltc') return false;
  }
  const chain = tokenChainKey(c);
  if (chain === 'evm') return /^0x[0-9a-fA-F]{40}$/.test(v);
  if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  if (chain === 'trx') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v);
  const len = lengths(c);
  if (len && !len.includes(v.length)) return false;
  const p = pattern(c);
  if (p === null || p === '') return true;
  return new RegExp(`(^|\\s)(${p})($|\\s)`).test(v);
}
