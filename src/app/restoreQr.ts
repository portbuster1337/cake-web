// Restoring a wallet from a scanned QR code (lib/view_model/restore/wallet_restore_from_qr_code.dart,
// restore_wallet.dart): the wallet type from the code (else the user picks it), the seed / keys / view-only
// data from its query (a 12–26-word run or an address found in the raw text otherwise), and the restore mode.

import { isEvm, walletCurrency, type WalletType } from '../coins/types.ts';
import { isBip39Word, validateBip39 } from '../coins/seeds/bip39.ts';
import { isValidAddressFor } from '../core/addressValidator.ts';

/** _walletTypeMap */
const TYPES: Record<string, WalletType> = {
  monero: 'monero', 'monero-wallet': 'monero', monero_wallet: 'monero',
  bitcoin: 'bitcoin', 'bitcoin-wallet': 'bitcoin', bitcoin_wallet: 'bitcoin',
  litecoin: 'litecoin', 'litecoin-wallet': 'litecoin', litecoin_wallet: 'litecoin',
  'ethereum-wallet': 'ethereum', 'polygon-wallet': 'polygon', 'base-wallet': 'base', 'arbitrum-wallet': 'arbitrum', 'bsc-wallet': 'bsc', 'robinhood-wallet': 'robinhood',
  'nano-wallet': 'nano', nano_wallet: 'nano',
  bitcoincash: 'bitcoinCash', 'bitcoincash-wallet': 'bitcoinCash', bitcoincash_wallet: 'bitcoinCash',
  'solana-wallet': 'solana',
  tron: 'tron', 'tron-wallet': 'tron', tron_wallet: 'tron',
  wownero: 'wownero', 'wownero-wallet': 'wownero', wownero_wallet: 'wownero',
  zano: 'zano', 'zano-wallet': 'zano', zano_wallet: 'zano',
  decred: 'decred', 'decred-wallet': 'decred', decred_wallet: 'decred',
  dogecoin: 'dogecoin', 'dogecoin-wallet': 'dogecoin', dogecoin_wallet: 'dogecoin',
  zcash: 'zcash', 'zcash-wallet': 'zcash', zcash_wallet: 'zcash',
};
const KEYS_BY_LENGTH = Object.keys(TYPES).sort((a, b) => b.length - a.length);

/** ScanValueException / BadMnemonicException / BadWalletTypeException: shown as they are */
export class RestoreQrError extends Error {}

/** Monero's view-only export: {"version":0,"primaryAddress","privateViewKey","restoreHeight","label"} */
function moneroViewOnly(code: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(code);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** _extractWalletType: the longest type name in the code; an xpub or zpub is Bitcoin; Monero's view-only JSON */
export function extractWalletType(code: string): WalletType | null {
  const lower = code.toLowerCase();
  const found = KEYS_BY_LENGTH.find((k) => lower.includes(k));
  if (code.startsWith('xpub') || code.startsWith('zpub')) return 'bitcoin';
  if (!found) {
    const j = moneroViewOnly(code);
    if (j && j.version === 0 && j.primaryAddress != null && j.privateViewKey != null && j.restoreHeight != null) return 'monero';
    return null;
  }
  return TYPES[found];
}

const SEED_LENGTHS = [12, 13, 14, 16, 18, 24, 25, 26];

/**
 * _extractSeedPhraseFromUrl: a run of 12, 13, 14, 16, 18, 24, 25 or 26 words. Whole runs first (Cake looks for 12
 * words first, which takes the start of a 25-word phrase), then Cake's search inside longer runs.
 */
export function extractSeedPhrase(raw: string): string | null {
  for (const m of raw.matchAll(/(?<=\W|^)\w+(?:\s+\w+)*(?=\W|$)/g)) {
    if (SEED_LENGTHS.includes(m[0].split(/\s+/).length)) return m[0].trim();
  }
  for (const n of SEED_LENGTHS) {
    const m = new RegExp(`(?<=\\W|^)((?:\\w+\\s+){${n - 1}}\\w+)(?=\\W|$)`).exec(raw);
    if (m) return m[1].trim();
  }
  return null;
}

/** _extractAddressFromUrl (AddressResolverUtils.extractAddressByType): the first word that is an address of the type */
export function extractAddress(raw: string, type: WalletType): string | null {
  const cur = walletCurrency(type);
  for (const word of raw.replace(/<[^>]*>/g, ' ').split(/[\s?&=,;"'<>()[\]{}]+/)) {
    for (const candidate of [word, word.replace(/^[a-z_-]+:/i, '')]) {
      if (candidate && isValidAddressFor(cur, candidate)) return candidate;
    }
  }
  return null;
}

export interface RestoreQr {
  type: WalletType;
  mode: 'seed' | 'keys';
  name: string;
  seed: string;
  passphrase: string;
  address: string;
  spendKey: string;
  viewKey: string;
  privateKey: string;
  height: string;
}

/**
 * scanQRCodeForRestoring once the type is known; `picked`: the user chose the type (only a seed phrase or an
 * xpub/zpub can then be read)
 */
export function parseRestoreQr(rawCode: string, type: WalletType, picked = false): RestoreQr {
  const code = rawCode.startsWith('[') ? rawCode.slice(rawCode.indexOf(']') + 1) : rawCode;
  const prefix = code.startsWith('xpub') ? 'xpub' : code.startsWith('zpub') ? 'zpub' : null;
  let query: string;
  if (picked) {
    const seed = extractSeedPhrase(code);
    if (seed) query = `seed=${encodeURIComponent(seed)}`;
    else if (prefix) query = `${prefix}=${encodeURIComponent(code)}`;
    else throw new RestoreQrError('Failed to determine valid seed phrase');
  } else if (prefix) query = `${prefix}=${encodeURIComponent(code)}`;
  else query = code.slice(code.indexOf(':') + 1).replace(/\?/g, '&');
  const q = new URLSearchParams(query);
  const p: Record<string, string> = {};
  q.forEach((v, k) => {
    if (!(k in p)) p[k] = v;
  });
  if (p.seed === undefined) {
    const s = extractSeedPhrase(code);
    if (s !== null) p.seed = s;
  }
  if (p.address === undefined) {
    const a = extractAddress(code, type);
    if (a !== null) p.address = a;
  }
  const mode = restoreMode(type, p, code);
  if (mode === 'seed') {
    return { type, mode, name: '', seed: p.mnemonic_seed ?? p.seed ?? p.hexSeed ?? '', passphrase: p.passphrase ?? '', address: p.address ?? '', spendKey: '', viewKey: '', privateKey: '', height: p.height ?? '' };
  }
  // RestoredWallet.fromKey: Monero's view-only JSON, xpub forms as an xpub, the xpub as the view key
  const j = moneroViewOnly(code);
  if (j && j.version === 0) {
    p.address = String(j.primaryAddress ?? '');
    p.view_key = String(j.privateViewKey ?? '');
    p.height = String(j.restoreHeight ?? '');
    if (typeof j.label === 'string') p.label = j.label;
  }
  const xpub = p.xpub ?? p.zpub ?? p.ltub;
  return { type, mode, name: p.label ?? '', seed: '', passphrase: '', address: p.address ?? '', spendKey: p.spend_key ?? '', viewKey: p.view_key ?? xpub ?? '', privateKey: p.private_key ?? '', height: p.height ?? '' };
}

/** _determineWalletRestoreMode */
function restoreMode(type: WalletType, p: Record<string, string>, raw: string): 'seed' | 'keys' {
  if ('tx_payment_id' in p) throw new RestoreQrError(p.tx_payment_id ? 'Unexpected restore mode: txids' : 'Unexpected restore mode: tx_payment_id is invalid');
  if ('xpub' in p || 'zpub' in p) return 'keys';
  if (p.seed !== undefined) {
    if (type === 'monero' || type === 'wownero') return 'seed';
    if (p.seed.split(' ').some((w) => !isBip39Word(w))) throw new RestoreQrError("Unexpected restore mode: mnemonic_seed is invalid or doesn't match wallet type");
    if (isEvm(type) && !validateBip39(p.seed)) throw new RestoreQrError('EVM mnemonic has an invalid checksum. Please check the seed phrase for typos.');
    return 'seed';
  }
  if ('spend_key' in p || 'view_key' in p) {
    if (p.spend_key || p.view_key) return 'keys';
    throw new RestoreQrError('Unexpected restore mode: spend_key or view_key is invalid');
  }
  if ((isEvm(type) || type === 'solana' || type === 'tron') && 'private_key' in p) {
    if (p.private_key) return 'keys';
    throw new RestoreQrError('Unexpected restore mode: private_key');
  }
  if (type === 'nano' && 'hexSeed' in p) {
    if (p.hexSeed) return 'seed';
    throw new RestoreQrError('Unexpected restore mode: hexSeed');
  }
  if (type === 'monero') {
    const j = moneroViewOnly(raw);
    if (!j) throw new RestoreQrError('Unexpected restore mode: restore params are invalid');
    if (j.version !== 0) throw new RestoreQrError('Found view-only restore with unsupported version');
    if (j.primaryAddress == null || j.privateViewKey == null || j.restoreHeight == null) throw new RestoreQrError('Missing one or more attributes in the JSON');
    return 'keys';
  }
  throw new RestoreQrError('Unexpected restore mode: restore params are invalid');
}
