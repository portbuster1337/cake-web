// What a wallet engine may use from the app (injected, so coin modules don't
// import the app layer): encrypted per-wallet cache, its WalletInfo, the
// current node of its type, settings, and its network isolation scope.

import type { WalletInfo, WalletSecrets } from './wallet.ts';
import type { Node } from './nodes.ts';
import type { Settings } from '../app/settings.ts';

export interface EngineContext {
  cacheGet<T>(key: string): Promise<T | undefined>;
  cachePut(key: string, v: unknown): Promise<void>;
  saveInfo(info: WalletInfo): Promise<void>;
  saveSecrets(s: WalletSecrets): Promise<void>;
  node(pow?: boolean): Node;
  settings(): Settings;
  /** every request of this wallet uses this isolation scope (own Tor circuits) */
  scope: string;
}

let factory: ((info: WalletInfo) => EngineContext) | null = null;

export function setEngineContextFactory(f: (info: WalletInfo) => EngineContext): void {
  factory = f;
}

export function engineContext(info: WalletInfo): EngineContext {
  if (!factory) throw new Error('Engine context not initialised');
  return factory(info);
}
