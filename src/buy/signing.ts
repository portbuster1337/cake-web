// Signed provider links: Onramper's Signature V2 and MoonPay's URL signature.
// Cake has its exchange helper sign them; this build signs with the user's own keys.

import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64, hex } from '@scure/base';
import { BuyProviderError } from './types.ts';

/** an Ed25519 private key: 32 bytes in hex, or a PKCS#8 PEM/DER (the seed is its last 32 bytes) */
export function onramperSigningSeed(raw: string): Uint8Array {
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return hex.decode(s.toLowerCase());
  const body = s.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = base64.decode(body);
  // 302e020100300506032b657004220420 ‖ seed
  if (der.length !== 48 || bytesToHex(der.subarray(0, 16)) !== '302e020100300506032b657004220420') throw new BuyProviderError('The Onramper signing key is not an Ed25519 private key');
  return der.subarray(16);
}

/** Onramper Signature V2 for a widget link: sigV2, its timestamp, nonce and the signed field names */
export function onramperSignatureV2(fields: Record<string, string>, seed: Uint8Array, now = new Date(), nonce = crypto.randomUUID()): Record<string, string> {
  const q = new URLSearchParams(fields);
  q.sort();
  const timestamp = now.toISOString();
  const canonical = ['ONRAMPER-SIG-V2', timestamp, nonce, 'GET', '/', q.toString(), '', bytesToHex(sha256(new Uint8Array()))].join('\n');
  const sig = ed25519.sign(utf8ToBytes(canonical), seed);
  return { sigV2: `v2:${base64.encode(sig)}`, sigV2Timestamp: timestamp, sigV2Nonce: nonce, sigV2Fields: [...q.keys()].join(',') };
}

/** MoonPay's URL signing: base64(HMAC-SHA256(secret key, "?" + query)) */
export function moonpaySignature(query: string, secret: string): string {
  return base64.encode(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(query.startsWith('?') ? query : `?${query}`)));
}

