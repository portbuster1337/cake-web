// Cake Wallet's key tree for the Electrum-family coins
// (cw_bitcoin/lib/electrum_wallet.dart, electrum_wallet_addresses.dart):
//  * accountHD = BIP32(seed).derivePath(hardened prefix of derivationPath ?? "m/0'")
//    (or the given xpub); mainHd = accountHD/0, sideHd = accountHD/1 — the "legacy" chains.
//  * BIP39 wallets (not Electrum) use standard per-type chains
//    m/<purpose>'/<coin>'/<account>'/<0|1>/i with purpose P2PKH 44, P2SH 49,
//    P2WPKH 84, P2TR 86, P2WSH 84 (same key as P2WPKH).
//  * Electrum derivation (or xpub-only): every type uses mainHd/sideHd.

import { HDKey } from '@scure/bip32';
import { NETWORKS, pubkeyToAddress, type AddressType, type UtxoCoin } from './networks.ts';

export type DerivationType = 'electrum' | 'bip39';

export const PURPOSE: Partial<Record<AddressType, number>> = { p2pkh: 44, p2sh: 49, p2wpkh: 84, p2tr: 86, p2wsh: 84 };

/** Address types per coin and account (BITCOIN_ADDRESS_TYPES, LITECOIN_ADDRESS_TYPES, …) */
export function addressTypesFor(coin: UtxoCoin, account = 0, hardware = false): AddressType[] {
  if (coin === 'btc') return hardware || account > 0 ? ['p2wpkh'] : ['p2wpkh', 'p2pkh', 'p2tr', 'p2wsh', 'p2sh'];
  if (coin === 'ltc') return ['p2wpkh'];
  return ['p2pkh'];
}

/** Types for which a BIP39 BTC wallet also keeps a chain on its saved derivation path. */
export const LEGACY_CHAIN_TYPES: AddressType[] = ['p2pkh', 'p2tr', 'p2sh'];

/** "m/84'/0'/0'/0" -> "m/84'/0'/0'" */
export function hardenedPrefix(path: string): string {
  const i = path.lastIndexOf("'");
  return i < 0 ? 'm' : path.slice(0, i + 1);
}

export interface ChainId {
  type: AddressType;
  account: number;
  change: boolean;
  legacy: boolean;
}

export function chainKey(c: ChainId): string {
  return `${c.account}:${c.type}:${c.change ? 1 : 0}:${c.legacy ? 'L' : 'S'}`;
}

export class KeyTree {
  readonly coin: UtxoCoin;
  readonly derivationType: DerivationType;
  readonly derivationPath: string;
  readonly master: HDKey | null;
  readonly accountHD: HDKey;
  #chains = new Map<string, HDKey>();

  constructor(opts: { coin: UtxoCoin; seed?: Uint8Array; xpub?: string; derivationType: DerivationType; derivationPath?: string }) {
    this.coin = opts.coin;
    this.derivationType = opts.derivationType;
    const versions = NETWORKS[opts.coin].bip32;
    this.derivationPath = opts.derivationPath ?? defaultDerivationPath(opts.coin, opts.derivationType);
    if (opts.seed) {
      this.master = HDKey.fromMasterSeed(opts.seed, versions);
      this.accountHD = this.master.derive(hardenedPrefix(this.derivationPath));
    } else if (opts.xpub) {
      this.master = null;
      this.accountHD = HDKey.fromExtendedKey(opts.xpub, versions);
    } else throw new Error('No seed or xpub');
  }

  get isWatchOnly(): boolean {
    return !this.master;
  }

  get coinType(): number {
    return NETWORKS[this.coin].coinType;
  }

  /** whether standard per-type chains apply (BIP39 + master seed) */
  get standardChains(): boolean {
    return !!this.master && this.derivationType !== 'electrum';
  }

  /** "m/84'/0'/0'" for a type/account, or the wallet's own account path for legacy/electrum chains */
  accountPath(type: AddressType, account: number, legacy: boolean): string {
    if (!this.standardChains || legacy) return hardenedPrefix(this.derivationPath);
    if (this.coin === 'ltc') return `m/84'/2'/${account}'`;
    if (this.coin === 'bch') return `m/44'/145'/${account}'`;
    if (this.coin === 'doge') return `m/44'/3'/${account}'`;
    return `m/${PURPOSE[type] ?? 84}'/${this.coinType}'/${account}'`;
  }

  chain(c: ChainId): HDKey {
    const k = chainKey(c);
    let h = this.#chains.get(k);
    if (!h) {
      const base = !this.standardChains || c.legacy ? this.accountHD : this.master!.derive(this.accountPath(c.type, c.account, false));
      h = base.deriveChild(c.change ? 1 : 0);
      this.#chains.set(k, h);
    }
    return h;
  }

  pubkey(c: ChainId, index: number): Uint8Array {
    return this.chain(c).deriveChild(index).publicKey!;
  }

  privkey(c: ChainId, index: number): Uint8Array {
    const k = this.chain(c).deriveChild(index).privateKey;
    if (!k) throw new Error('This is a watch-only wallet');
    return k;
  }

  address(c: ChainId, index: number): string {
    return pubkeyToAddress(NETWORKS[this.coin], this.pubkey(c, index), c.type);
  }

  /** full derivation path shown for an address (bitcoin_address_record.dart, incl. Cake's display quirks) */
  displayPath(c: ChainId, index: number): string {
    if (c.legacy || !this.standardChains) return `${hardenedPrefix(this.derivationPath)}/${c.change ? 1 : 0}/${index}`;
    const purpose = c.type === 'p2wsh' ? 48 : PURPOSE[c.type] ?? 84;
    const acct = this.coin === 'btc' ? `m/${purpose}'/${this.coinType}'/${c.account}'` : this.accountPath(c.type, c.account, false);
    return `${acct}/${c.change ? 1 : 0}/${index}`;
  }

  /** Keys page: the account-0 P2WPKH (or P2PKH) receive chain node, the account xpub and the master fingerprint. */
  keysInfo(): { wif: string; privateKey: string; publicKey: string; xpub: string; fingerprint: string } {
    const mainType: AddressType = this.coin === 'btc' || this.coin === 'ltc' ? 'p2wpkh' : 'p2pkh';
    const node = this.chain({ type: mainType, account: 0, change: false, legacy: false });
    const net = NETWORKS[this.coin];
    const priv = node.privateKey;
    const acct = this.standardChains ? this.master!.derive(this.accountPath(mainType, 0, false)) : this.accountHD;
    const xpub = HDKey.fromExtendedKey(acct.publicExtendedKey, acct.versions);
    // standard xpub version bytes even for LTC/BCH (Cake shows xpub)
    const std = new HDKey({ versions: { public: 0x0488b21e, private: 0x0488ade4 }, chainCode: xpub.chainCode!, publicKey: xpub.publicKey!, depth: xpub.depth, index: xpub.index, parentFingerprint: xpub.parentFingerprint });
    return {
      wif: priv ? wifEncode(priv, net.wif) : '',
      privateKey: priv ? toHex(priv) : '',
      publicKey: toHex(node.publicKey!),
      xpub: std.publicExtendedKey,
      fingerprint: this.master ? this.master.fingerprint.toString(16).padStart(8, '0') : '',
    };
  }
}

export function defaultDerivationPath(coin: UtxoCoin, type: DerivationType): string {
  if (type === 'electrum') return "m/0'";
  if (coin === 'ltc') return "m/84'/2'/0'";
  if (coin === 'bch') return "m/44'/145'/0'";
  if (coin === 'doge') return "m/44'/3'/0'";
  return "m/84'/0'/0'";
}

import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function wifEncode(priv: Uint8Array, version: number, compressed = true): string {
  const payload = Uint8Array.from([version, ...priv, ...(compressed ? [1] : [])]);
  const chk = sha256(sha256(payload)).slice(0, 4);
  return base58.encode(Uint8Array.from([...payload, ...chk]));
}

/** zpub/ypub/Ltub/vpub → xpub (cw_core/lib/utils/zpub.dart): same payload, standard version bytes */
export function convertAnyToXpub(key: string): string {
  const raw = base58.decode(key.trim());
  const body = raw.slice(0, -4);
  const ver = (body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3];
  const map: Record<number, number> = { 0x04b24746: 0x0488b21e, 0x049d7cb2: 0x0488b21e, 0x019da462: 0x0488b21e, 0x045f1cf6: 0x043587cf };
  const target = map[ver >>> 0];
  if (!target) return key.trim();
  const nb = Uint8Array.from([(target >>> 24) & 0xff, (target >>> 16) & 0xff, (target >>> 8) & 0xff, target & 0xff, ...body.slice(4)]);
  const chk = sha256(sha256(nb)).slice(0, 4);
  return base58.encode(Uint8Array.from([...nb, ...chk]));
}
