// UTXO coin parameters (mainnet) and address encoding for Bitcoin,
// Litecoin, Bitcoin Cash and Dogecoin.

import { p2pkh, p2wpkh, p2sh, p2tr, p2wsh, p2ms, Address, OutScript } from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { cashaddrEncode, cashaddrDecode } from './cashaddr.ts';

export type UtxoCoin = 'btc' | 'ltc' | 'bch' | 'doge';

export type AddressType = 'p2wpkh' | 'p2pkh' | 'p2sh' | 'p2tr' | 'p2wsh' | 'silent_payments' | 'mweb';

export interface UtxoNetwork {
  coin: UtxoCoin;
  bech32?: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
  /** BIP44 coin type */
  coinType: number;
  /** satoshis per coin */
  decimals: number;
  segwit: boolean;
  /** dust limit used when deciding whether change is worth an output */
  dust: bigint;
  /** BIP32 version bytes for xpub/xprv */
  bip32: { public: number; private: number };
}

export const NETWORKS: Record<UtxoCoin, UtxoNetwork> = {
  btc: { coin: 'btc', bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80, coinType: 0, decimals: 8, segwit: true, dust: 546n, bip32: { public: 0x0488b21e, private: 0x0488ade4 } },
  ltc: { coin: 'ltc', bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0, coinType: 2, decimals: 8, segwit: true, dust: 546n, bip32: { public: 0x0488b21e, private: 0x0488ade4 } },
  bch: { coin: 'bch', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80, coinType: 145, decimals: 8, segwit: false, dust: 546n, bip32: { public: 0x0488b21e, private: 0x0488ade4 } },
  doge: { coin: 'doge', pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e, coinType: 3, decimals: 8, segwit: false, dust: 1_000_000n, bip32: { public: 0x02facafd, private: 0x02fac398 } },
};

/** @scure/btc-signer network object */
export function signerNet(n: UtxoNetwork) {
  return { bech32: n.bech32 ?? 'bc', pubKeyHash: n.pubKeyHash, scriptHash: n.scriptHash, wif: n.wif };
}

export function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

/** Address of a compressed public key for the given address type. */
export function pubkeyToAddress(net: UtxoNetwork, pub: Uint8Array, type: AddressType): string {
  const sn = signerNet(net);
  switch (type) {
    case 'p2wpkh':
      return p2wpkh(pub, sn).address!;
    case 'p2pkh':
      if (net.coin === 'bch') return cashaddrEncode('bitcoincash', 'p2pkh', hash160(pub));
      return p2pkh(pub, sn).address!;
    case 'p2sh':
      return p2sh(p2wpkh(pub, sn), sn).address!;
    case 'p2tr':
      return p2tr(pub.length === 33 ? pub.slice(1) : pub, undefined, sn).address!;
    case 'p2wsh':
      // Cake's P2WSH: 1-of-1 bare multisig (OP_1 <K> OP_1 OP_CHECKMULTISIG) on the P2WPKH key
      return p2wsh(p2ms(1, [pub]), sn).address!;
    default:
      throw new Error(`Unsupported address type ${type}`);
  }
}

/** Output script (hex-able bytes) for any address of this network. */
export function addressToScript(net: UtxoNetwork, address: string): Uint8Array {
  if (net.coin === 'bch') {
    const a = address.trim();
    if (a.includes(':') || /^[qp][a-z0-9]{41}$/i.test(a)) {
      const { type, hash } = cashaddrDecode(a.includes(':') ? a : `bitcoincash:${a}`);
      return type === 'p2pkh' ? OutScript.encode({ type: 'pkh', hash }) : OutScript.encode({ type: 'sh', hash });
    }
  }
  const dec = Address(signerNet(net)).decode(address.trim());
  return OutScript.encode(dec);
}

export function isValidAddress(net: UtxoNetwork, address: string): boolean {
  try {
    addressToScript(net, address);
    return true;
  } catch {
    return false;
  }
}

/** Address for an output script, if it is a standard one. */
export function scriptToAddress(net: UtxoNetwork, script: Uint8Array): string | undefined {
  try {
    const dec = OutScript.decode(script);
    if (net.coin === 'bch' && (dec.type === 'pkh' || dec.type === 'sh')) return cashaddrEncode('bitcoincash', dec.type === 'pkh' ? 'p2pkh' : 'p2sh', dec.hash);
    return Address(signerNet(net)).encode(dec);
  } catch {
    return undefined;
  }
}

/** BCH: convert legacy base58 addresses to cashaddr (Cake shows cashaddr). */
export function toCashAddr(address: string): string {
  const a = address.trim();
  if (a.startsWith('bitcoincash:')) return a;
  if (/^[qp][a-z0-9]{41}$/.test(a)) return `bitcoincash:${a}`;
  const dec = Address(signerNet(NETWORKS.bch)).decode(a);
  if (dec.type === 'pkh') return cashaddrEncode('bitcoincash', 'p2pkh', dec.hash);
  if (dec.type === 'sh') return cashaddrEncode('bitcoincash', 'p2sh', dec.hash);
  throw new Error('Not a Bitcoin Cash address');
}
