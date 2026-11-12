// Minimal IndexedDB layer (with an in-memory fallback for tests/Node).
// Object stores:
//   kv      — small non-secret values (UI language/theme before unlock, PIN key wrap, lockout counters)
//   secure  — encrypted records (AES-256-GCM with the app data key): settings, wallets, seeds, caches, trades…

export type StoreName = 'kv' | 'secure';

const DB_NAME = 'cake-web';
const DB_VERSION = 1;

interface Backend {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  del(store: StoreName, key: string): Promise<void>;
  keys(store: StoreName, prefix?: string): Promise<string[]>;
  clear(store: StoreName): Promise<void>;
}

class MemoryBackend implements Backend {
  #m: Record<StoreName, Map<string, unknown>> = { kv: new Map(), secure: new Map() };
  async get<T>(s: StoreName, k: string) {
    const v = this.#m[s].get(k);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(s: StoreName, k: string, v: unknown) {
    this.#m[s].set(k, structuredClone(v));
  }
  async del(s: StoreName, k: string) {
    this.#m[s].delete(k);
  }
  async keys(s: StoreName, prefix = '') {
    return [...this.#m[s].keys()].filter((k) => k.startsWith(prefix));
  }
  async clear(s: StoreName) {
    this.#m[s].clear();
  }
}

class IdbBackend implements Backend {
  #db: Promise<IDBDatabase> | null = null;

  #open(): Promise<IDBDatabase> {
    if (!this.#db) {
      this.#db = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of ['kv', 'secure'] as StoreName[]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            this.#db = null;
          };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
      });
    }
    return this.#db;
  }

  async #tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  get<T>(s: StoreName, k: string) {
    return this.#tx<T | undefined>(s, 'readonly', (st) => st.get(k) as IDBRequest<T | undefined>);
  }
  async put(s: StoreName, k: string, v: unknown) {
    await this.#tx(s, 'readwrite', (st) => st.put(v, k));
  }
  async del(s: StoreName, k: string) {
    await this.#tx(s, 'readwrite', (st) => st.delete(k));
  }
  async keys(s: StoreName, prefix = '') {
    const all = await this.#tx<IDBValidKey[]>(s, 'readonly', (st) => st.getAllKeys());
    return all.map(String).filter((k) => k.startsWith(prefix));
  }
  async clear(s: StoreName) {
    await this.#tx(s, 'readwrite', (st) => st.clear());
  }
}

export const db: Backend = typeof indexedDB !== 'undefined' ? new IdbBackend() : new MemoryBackend();

export function useMemoryDb(): Backend {
  return new MemoryBackend();
}
