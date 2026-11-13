// SLIP-0010 key derivation for ed25519 (hardened steps only), as used by
// Cake's Solana (m/44'/501'/0'/0') and Nano HD (m/44'/165'/i') wallets.

import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export function slip10Ed25519(seed: Uint8Array, path: string): { key: Uint8Array; chainCode: Uint8Array } {
  let I = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);
  for (const step of path.replace(/^m\/?/, '').split('/').filter(Boolean)) {
    if (!step.endsWith("'")) throw new Error('ed25519 derivation supports hardened steps only');
    const index = (Number(step.slice(0, -1)) + 0x80000000) >>> 0;
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }
  return { key, chainCode };
}
