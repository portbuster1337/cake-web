// Cake Wallet's backup container (cake_backup@b5d86a2a lib/backup.dart) and
// the backup v3 file (lib/core/backup_service_v3.dart): an outer ZIP with
// data.bin (the payload in 24 MiB chunks, each one a cake_backup v2 container),
// metadata.json and README.txt.

import { blake2b } from '@noble/hashes/blake2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { zipSync } from 'fflate';

const CHUNK = 24 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class BackupError extends Error {}

export const sha512hex = (b: Uint8Array): string => bytesToHex(sha512(b));

// ------------------------------------------------------------ container --

async function pbkdf2(pass: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: salt as BufferSource, iterations }, key, 256));
}

function checksum(version: number, salt: Uint8Array, nonce: Uint8Array, tag: Uint8Array, ct: Uint8Array): Uint8Array {
  const aad = utf8ToBytes(`Cake Wallet backup v${version}`);
  return blake2b.create({ dkLen: 64 }).update(Uint8Array.of(aad.length)).update(aad).update(Uint8Array.of(version)).update(salt).update(nonce).update(tag).update(ct).digest();
}

/** cake_backup encrypt: version || salt(16) || nonce(24) || tag(16) || checksum(64) || ciphertext */
export async function cbEncrypt(passphrase: string, plaintext: Uint8Array, version: 2 | 3 = 2): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const key = await pbkdf2(passphrase, salt, version === 2 ? 120_000 : 1);
  const sealed = xchacha20poly1305(key, nonce, utf8ToBytes(`Cake Wallet backup v${version}`)).encrypt(plaintext);
  const ct = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  return concatBytes(Uint8Array.of(version), salt, nonce, tag, checksum(version, salt, nonce, tag, ct), ct);
}

export async function cbDecrypt(passphrase: string, blob: Uint8Array): Promise<Uint8Array> {
  const version = blob[0];
  if (version !== 2 && version !== 3) throw new BackupError('The backup file uses a version that this software does not understand (error code: BadProtocolVersion).');
  if (blob.length < 121) throw new BackupError('The backup file is corrupted and could not be recovered (error code: BadDataLength).');
  const salt = blob.subarray(1, 17);
  const nonce = blob.subarray(17, 41);
  const tag = blob.subarray(41, 57);
  const sum = blob.subarray(57, 121);
  const ct = blob.subarray(121);
  if (bytesToHex(checksum(version, salt, nonce, tag, ct)) !== bytesToHex(sum)) throw new BackupError('The backup file is corrupted and could not be recovered (error code: BadChecksum).');
  const key = await pbkdf2(passphrase, salt, version === 2 ? 120_000 : 1);
  try {
    return xchacha20poly1305(key, nonce, utf8ToBytes(`Cake Wallet backup v${version}`)).decrypt(concatBytes(ct, tag));
  } catch {
    throw new BackupError('Failed to decrypt backup file, please check you entered the right password');
  }
}


// -------------------------------------------------------------- v3 file --

/** the outer ZIP: data.bin, metadata.json (JSON.stringify(m, null, 4), like Dart's JsonEncoder.withIndent), README.txt */
export async function packBackupV3(payload: Uint8Array, password: string, appName: string, version: string, now = new Date()): Promise<Uint8Array> {
  const encrypted: Uint8Array[] = [];
  const chunks: { sha512sum: { encrypted: string; plain: string }; length: { encrypted: number; plain: number } }[] = [];
  for (let off = 0; off === 0 || off < payload.length; off += CHUNK) {
    const plain = payload.subarray(off, Math.min(payload.length, off + CHUNK));
    const e = await cbEncrypt(password, plain);
    encrypted.push(e);
    chunks.push({ sha512sum: { encrypted: sha512hex(e), plain: sha512hex(plain) }, length: { encrypted: e.length, plain: plain.length } });
    if (!payload.length) break;
  }
  const metadata = { version: 3, sha512sum: sha512hex(payload), chunks, cakeVersion: version };
  const readme = `This is a ${appName} backup. Do not modify this archive.\n\nApp version: ${version}\n\nIf you have any issues with this backup, please contact our in-app support.\nThis backup was created on ${now.toISOString()}`;
  return zipSync({ 'data.bin': concatBytes(...encrypted), 'metadata.json': enc.encode(JSON.stringify(metadata, null, 4)), 'README.txt': enc.encode(readme) }, { level: 9 });
}

/** the payload of an outer ZIP's entries: every chunk's checksum, then the whole payload's */
export async function unpackBackupV3(outer: Record<string, Uint8Array>, password: string): Promise<Uint8Array> {
  const meta = outer['metadata.json'];
  if (!meta) throw new BackupError('Invalid v3 backup: missing metadata.json');
  const data = outer['data.bin'];
  if (!data) throw new BackupError('Invalid v3 backup: missing data.bin');
  const m = JSON.parse(dec.decode(meta)) as { version: number; sha512sum: string; chunks: { sha512sum: { encrypted: string }; length: { encrypted: number } }[] };
  if (m.version !== 3) throw new BackupError('This is not a valid backup file, please make sure you have selected the correct one');
  const parts: Uint8Array[] = [];
  let off = 0;
  for (const [i, c] of m.chunks.entries()) {
    const e = data.subarray(off, off + c.length.encrypted);
    off += c.length.encrypted;
    if (sha512hex(e) !== c.sha512sum.encrypted) throw new BackupError(`Invalid v3 backup: chunk (${e.length} bytes) checksum mismatch at index ${i}`);
    parts.push(await cbDecrypt(password, e));
  }
  const payload = concatBytes(...parts);
  if (sha512hex(payload) !== m.sha512sum) throw new BackupError('Invalid v3 backup: SHA512 checksum mismatch');
  return payload;
}
