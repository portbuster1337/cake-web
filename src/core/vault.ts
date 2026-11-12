// The app's encrypted storage. One random 256-bit data key (DEK) encrypts
// every sensitive record (AES-256-GCM, record key as associated data). The
// DEK itself is stored only wrapped by a key derived from the PIN
// (PBKDF2-SHA256), so the PIN unlocks everything and changing it only
// re-wraps the DEK. Nothing sensitive is ever written unencrypted.

import { db } from './db.ts';
import { base64 } from '@scure/base';

const WRAP_KEY = 'vault:wrap';
const DURESS_WRAP_KEY = 'vault:duress-wrap';
export const PBKDF2_ITERATIONS = 600_000;

interface WrapRecord {
  v: 1;
  salt: Uint8Array;
  iterations: number;
  iv: Uint8Array;
  wrapped: Uint8Array;
  pinLength: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** JSON with Uint8Array and bigint support. */
export function serialize(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (x instanceof Uint8Array) return { __u8: base64.encode(x) };
    if (typeof x === 'bigint') return { __bi: x.toString() };
    return x;
  });
}

export function deserialize<T>(s: string): T {
  return JSON.parse(s, (_k, x) => {
    if (x && typeof x === 'object') {
      if (typeof x.__u8 === 'string' && Object.keys(x).length === 1) return base64.decode(x.__u8);
      if (typeof x.__bi === 'string' && Object.keys(x).length === 1) return BigInt(x.__bi);
    }
    return x;
  }) as T;
}

async function kek(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations, salt: salt as BufferSource }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function wrap(pin: string, dekRaw: Uint8Array): Promise<WrapRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await kek(pin, salt, PBKDF2_ITERATIONS);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode('cake-web:dek') }, k, dekRaw as BufferSource));
  return { v: 1, salt, iv, wrapped, iterations: PBKDF2_ITERATIONS, pinLength: pin.length };
}

async function unwrap(pin: string, rec: WrapRecord): Promise<Uint8Array | null> {
  const k = await kek(pin, rec.salt, rec.iterations);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource, additionalData: enc.encode('cake-web:dek') }, k, rec.wrapped as BufferSource));
  } catch {
    return null;
  }
}

export type UnlockResult = 'ok' | 'duress' | 'wrong';

class VaultImpl {
  #dek: CryptoKey | null = null;
  #dekRaw: Uint8Array | null = null;
  #cache = new Map<string, unknown>();
  /** namespace prefix: the duress PIN opens a separate, empty space */
  #ns = '';

  get unlocked(): boolean {
    return !!this.#dek;
  }

  get duress(): boolean {
    return this.#ns === 'duress:';
  }

  async isSetUp(): Promise<boolean> {
    return !!(await db.get<WrapRecord>('kv', WRAP_KEY));
  }

  async pinLength(): Promise<number> {
    return (await db.get<WrapRecord>('kv', WRAP_KEY))?.pinLength ?? 4;
  }

  /** First run: create the data key and protect it with the PIN. */
  async setup(pin: string): Promise<void> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    await db.put('kv', WRAP_KEY, await wrap(pin, raw));
    this.#dekRaw = raw;
    this.#dek = await importDek(raw);
    this.#ns = '';
    this.#cache.clear();
  }

  async unlock(pin: string): Promise<UnlockResult> {
    const rec = await db.get<WrapRecord>('kv', WRAP_KEY);
    if (!rec) throw new Error('No PIN set');
    const raw = await unwrap(pin, rec);
    if (raw) {
      this.#dekRaw = raw;
      this.#dek = await importDek(raw);
      this.#ns = '';
      this.#cache.clear();
      return 'ok';
    }
    const d = await db.get<WrapRecord>('kv', DURESS_WRAP_KEY);
    if (d) {
      const draw = await unwrap(pin, d);
      if (draw) {
        this.#dekRaw = draw;
        this.#dek = await importDek(draw);
        this.#ns = 'duress:';
        this.#cache.clear();
        return 'duress';
      }
    }
    return 'wrong';
  }

  /** Check a PIN without changing state (re-authentication). */
  async verify(pin: string): Promise<boolean> {
    const rec = await db.get<WrapRecord>('kv', WRAP_KEY);
    if (!rec) return false;
    const raw = await unwrap(pin, rec);
    return !!raw;
  }

  async changePin(newPin: string): Promise<void> {
    if (!this.#dekRaw || this.duress) throw new Error('Locked');
    await db.put('kv', WRAP_KEY, await wrap(newPin, this.#dekRaw));
  }

  async setDuressPin(pin: string | null): Promise<void> {
    if (!this.#dekRaw || this.duress) throw new Error('Locked');
    if (pin === null) {
      await db.del('kv', DURESS_WRAP_KEY);
      return;
    }
    const raw = crypto.getRandomValues(new Uint8Array(32));
    await db.put('kv', DURESS_WRAP_KEY, await wrap(pin, raw));
  }

  async hasDuressPin(): Promise<boolean> {
    return !!(await db.get('kv', DURESS_WRAP_KEY));
  }

  lock(): void {
    this.#dek = null;
    this.#dekRaw?.fill(0);
    this.#dekRaw = null;
    this.#cache.clear();
    this.#ns = '';
  }

  #key(k: string): string {
    return this.#ns + k;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (!this.#dek) throw new Error('Vault is locked');
    const k = this.#key(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(k) }, this.#dek, enc.encode(serialize(value)) as BufferSource));
    await db.put('secure', k, { iv, data });
    this.#cache.set(k, value);
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.#dek) throw new Error('Vault is locked');
    const k = this.#key(key);
    if (this.#cache.has(k)) return this.#cache.get(k) as T;
    const rec = await db.get<{ iv: Uint8Array; data: Uint8Array }>('secure', k);
    if (!rec) return undefined;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource, additionalData: enc.encode(k) }, this.#dek, rec.data as BufferSource);
    const v = deserialize<T>(dec.decode(plain));
    this.#cache.set(k, v);
    return v;
  }

  async del(key: string): Promise<void> {
    const k = this.#key(key);
    this.#cache.delete(k);
    await db.del('secure', k);
  }

  async keys(prefix = ''): Promise<string[]> {
    const p = this.#key(prefix);
    return (await db.keys('secure', p)).map((k) => k.slice(this.#ns.length)).filter((k) => this.#ns || !k.startsWith('duress:'));
  }

  async getAll<T>(prefix: string): Promise<T[]> {
    const out: T[] = [];
    for (const k of await this.keys(prefix)) {
      const v = await this.get<T>(k);
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  /** Erase everything (used by "wipe" and by tests). */
  async wipe(): Promise<void> {
    this.lock();
    await db.clear('secure');
    await db.clear('kv');
  }
}

export const vault = new VaultImpl();
