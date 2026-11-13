// App lifecycle (AppStore + AuthenticationStore + WalletLoadingService in Cake):
// boot, PIN setup/unlock/lock, wallet registry, opening/closing wallets.

import { groupIdentifierOf } from './groups.ts';
import { loadTrades, monitorActiveTrades, unloadTrades } from '../exchange/trades.ts';
import { loadOrders, unloadOrders } from '../cakepay/service.ts';
import { signal, computed } from '@preact/signals';
import { vault } from '../core/vault.ts';
import { db } from '../core/db.ts';
import { NetRouter } from '../net/router.ts';
import { setRouter } from '../net/http.ts';
import { setLanguage, detectLanguage } from '../core/i18n.ts';
import { applyTheme } from '../ui/theme/themes.ts';
import { settings, loadSettings, updateSettings, resetSettingsLoaded } from './settings.ts';
import { coinModule, type NewWalletOptions, type RestoreSeedOptions, type RestoreKeysOptions } from '../coins/module.ts';
import type { WalletBase, WalletInfo, WalletSecrets } from '../core/wallet.ts';
import type { WalletType } from '../coins/types.ts';
import { setEngineContextFactory } from '../core/engine.ts';
import { currentNode, customNodes, currentNodeIds } from '../core/nodes.ts';

export type Phase = 'boot' | 'welcome' | 'locked' | 'ready';

export const phase = signal<Phase>('boot');
export const walletInfos = signal<WalletInfo[]>([]);
export const currentWallet = signal<WalletBase | null>(null);
export const walletLoading = signal<string | null>(null);
export const walletError = signal<string | null>(null);
export const torStatus = signal<{ state: string; message: string; via?: string }>({ state: 'idle', message: '' });

export const BUILTIN_RELAYS = [
  // public tor-js gateway (WebRTC); it only ever sees encrypted Tor link traffic
  '152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ',
];

let router: NetRouter;

export function net(): NetRouter {
  return router;
}

async function siteRelays(): Promise<string[]> {
  try {
    const res = await fetch('./relays.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return [];
    const j = await res.json();
    const list: unknown = Array.isArray(j) ? j : j?.relays;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').map((x) => x.replace('{host}', location.host).replace('{ws}', location.protocol === 'https:' ? 'wss' : 'ws')) : [];
  } catch {
    return [];
  }
}

export async function effectiveRelays(): Promise<string[]> {
  const user = (await db.get<string[]>('kv', 'tor:relays')) ?? [];
  if (user.length) return user;
  return [...(await siteRelays()), ...BUILTIN_RELAYS];
}

export async function setUserRelays(relays: string[]): Promise<void> {
  await db.put('kv', 'tor:relays', relays);
  router.configure({ relays: await effectiveRelays() });
}

export async function boot(): Promise<void> {
  let lang = 'en';
  try {
    lang = localStorage.getItem('cw-lang') ?? detectLanguage();
    const th = localStorage.getItem('cw-theme');
    applyTheme(th === null ? null : Number(th));
  } catch {
    applyTheme(null);
  }
  await setLanguage(lang);
  const localNodes = (await db.get<string[]>('kv', 'net:localNodes')) ?? [];
  router = new NetRouter({ relays: await effectiveRelays(), localNodes });
  setRouter(router);
  router.onTorStatus((s) => (torStatus.value = { state: s.state, message: s.message, via: s.via }));
  // Tor bootstraps while the user enters the PIN: nothing is requested until then.
  void router.startTor().catch(() => {});
  phase.value = (await vault.isSetUp()) ? 'locked' : 'welcome';
}

// ------------------------------------------------------------------ PIN --

const LOCKOUT_KEY = 'auth:failures';
interface Failures {
  count: number;
  bannedUntil: number;
}

export async function lockoutState(): Promise<Failures> {
  return (await db.get<Failures>('kv', LOCKOUT_KEY)) ?? { count: 0, bannedUntil: 0 };
}

/** AuthViewModel: maxFailedLogins = 3, ban = (failures - 3 + 1) * 180 s. */
export const MAX_FAILED_LOGINS = 3;
export const BAN_TIMEOUT_S = 180;
function banDuration(count: number): number {
  if (count < MAX_FAILED_LOGINS) return 0;
  return (count - MAX_FAILED_LOGINS + 1) * BAN_TIMEOUT_S * 1000;
}

export async function setupPin(pin: string): Promise<void> {
  await vault.setup(pin);
  resetSettingsLoaded();
  await loadSettings();
  updateSettings({ pinLength: pin.length as 4 | 6, languageCode: settings.value.languageCode });
  await db.put('kv', 'pinLength', pin.length);
}

export type UnlockOutcome = { ok: true; duress: boolean } | { ok: false; bannedUntil?: number; attemptsLeft?: number };

export async function unlock(pin: string): Promise<UnlockOutcome> {
  const f = await lockoutState();
  if (f.bannedUntil > Date.now()) return { ok: false, bannedUntil: f.bannedUntil };
  const r = await vault.unlock(pin);
  if (r === 'duress') {
    await duressWipe();
    return { ok: false };
  }
  if (r === 'wrong') {
    const count = f.count + 1;
    const ban = banDuration(count);
    await db.put('kv', LOCKOUT_KEY, { count, bannedUntil: ban ? Date.now() + ban : 0 });
    return { ok: false, bannedUntil: ban ? Date.now() + ban : undefined, attemptsLeft: Math.max(0, MAX_FAILED_LOGINS - count) };
  }
  await db.put('kv', LOCKOUT_KEY, { count: 0, bannedUntil: 0 });
  resetSettingsLoaded();
  await loadSettings();
  router.online = true;
  await loadNodes();
  await loadWalletInfos();
  await loadTrades().catch(() => {});
  await loadOrders().catch(() => {});
  phase.value = 'ready';
  const id = settings.value.currentWalletId ?? walletInfos.value[0]?.id;
  if (id) void openWallet(id).catch((e) => (walletError.value = (e as Error).message));
  startIdleTimer();
  return { ok: true, duress: false };
}

/** in-app PIN checks; the duress PIN works there too */
export async function verifyPin(pin: string): Promise<boolean> {
  if (await vault.verify(pin)) return true;
  if (await vault.isDuressPin(pin)) await duressWipe();
  return false;
}

/**
 * AuthService._handleDuressLogin: the open wallet is closed, every wallet and every secret is erased, and
 * the app starts over at the welcome page. Cake keeps the address book, notes, nodes and settings; here
 * they are encrypted with the key of the erased PIN, so they go too.
 */
export async function duressWipe(): Promise<void> {
  const w = currentWallet.value;
  currentWallet.value = null;
  if (w) await w.close().catch(() => {});
  walletInfos.value = [];
  unloadTrades();
  unloadOrders();
  router.online = false;
  router.newIdentity();
  await vault.wipe();
  resetSettingsLoaded();
  phase.value = 'welcome';
}

export async function lock(): Promise<void> {
  const w = currentWallet.value;
  currentWallet.value = null;
  if (w) await w.close().catch(() => {});
  unloadTrades();
  unloadOrders();
  router.online = false;
  router.newIdentity();
  vault.lock();
  resetSettingsLoaded();
  phase.value = (await vault.isSetUp()) ? 'locked' : 'welcome';
}

// --------------------------------------------------------- inactivity --

let idleTimer: ReturnType<typeof setTimeout> | undefined;
let lastActive = Date.now();

function startIdleTimer() {
  if (typeof window === 'undefined') return;
  const reset = () => {
    lastActive = Date.now();
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, reset, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') lastActive = Date.now();
  });
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (phase.value !== 'ready') return;
    const minutes = settings.value.pinTimeOutDuration;
    if (minutes > 0 && Date.now() - lastActive > minutes * 60_000 && document.visibilityState === 'hidden') void lock();
    if (minutes > 0 && Date.now() - lastActive > Math.max(minutes, 5) * 60_000) void lock();
  }, 10_000);
}

// ------------------------------------------------------------ wallets --

const INFO = (id: string) => `wallet:${id}`;
const SECRETS = (id: string) => `secrets:${id}`;

export async function loadWalletInfos(): Promise<void> {
  const list = await vault.getAll<WalletInfo>('wallet:');
  const order = settings.value.walletListOrder;
  list.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.date - b.date;
  });
  // wallets from before wallet groups get their identifier once
  for (const w of list) {
    if (w.hashedWalletIdentifier) continue;
    w.hashedWalletIdentifier = groupIdentifierOf(w, await getSecrets(w.id));
    await vault.put(INFO(w.id), w);
  }
  walletInfos.value = list;
}

export async function saveWalletInfo(info: WalletInfo): Promise<void> {
  await vault.put(INFO(info.id), info);
  walletInfos.value = walletInfos.value.some((w) => w.id === info.id) ? walletInfos.value.map((w) => (w.id === info.id ? info : w)) : [...walletInfos.value, info];
}

export async function getSecrets(id: string): Promise<WalletSecrets> {
  return (await vault.get<WalletSecrets>(SECRETS(id))) ?? {};
}

export async function saveSecrets(id: string, s: WalletSecrets): Promise<void> {
  await vault.put(SECRETS(id), s);
}

/** Make the name unique the way Cake does (it refuses duplicates; we append a number). */
export function uniqueName(name: string): string {
  const names = new Set(walletInfos.value.map((w) => w.name));
  if (!names.has(name)) return name;
  for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
}

export function walletNameTaken(name: string, exceptId?: string): boolean {
  return walletInfos.value.some((w) => w.name === name && w.id !== exceptId);
}

async function persistNew(info: WalletInfo, secrets: WalletSecrets): Promise<WalletInfo> {
  // WalletCreationVM: hashedWalletIdentifier, the wallet group
  if (!info.hashedWalletIdentifier) info.hashedWalletIdentifier = groupIdentifierOf(info, secrets);
  await saveSecrets(info.id, secrets);
  await saveWalletInfo(info);
  return info;
}

export async function createWallet(type: WalletType, o: NewWalletOptions): Promise<WalletInfo> {
  const m = await coinModule(type);
  const { info, secrets } = await m.createWallet(o);
  return persistNew(info, secrets);
}

export async function restoreWalletFromSeed(type: WalletType, o: RestoreSeedOptions): Promise<WalletInfo> {
  const m = await coinModule(type);
  const { info, secrets } = await m.restoreFromSeed(o);
  return persistNew(info, secrets);
}

export async function restoreWalletFromKeys(type: WalletType, o: RestoreKeysOptions): Promise<WalletInfo> {
  const m = await coinModule(type);
  if (!m.restoreFromKeys) throw new Error('Restoring from keys is not supported for this wallet type');
  const { info, secrets } = await m.restoreFromKeys(o);
  return persistNew(info, secrets);
}

export async function openWallet(id: string): Promise<WalletBase> {
  const info = walletInfos.value.find((w) => w.id === id) ?? (await vault.get<WalletInfo>(INFO(id)));
  if (!info) throw new Error('Wallet not found');
  walletLoading.value = info.name;
  walletError.value = null;
  try {
    const prev = currentWallet.value;
    currentWallet.value = null;
    if (prev) await prev.close().catch(() => {});
    const m = await coinModule(info.type);
    const secrets = await getSecrets(id);
    const w = await m.open(info, secrets);
    currentWallet.value = w;
    updateSettings({ currentWalletId: id });
    monitorActiveTrades(id);
    void w.connect().then(() => w.startSync()).catch((e) => {
      w.syncStatus.value = { kind: 'failed', error: (e as Error).message };
    });
    return w;
  } catch (e) {
    walletError.value = (e as Error).message;
    throw e;
  } finally {
    walletLoading.value = null;
  }
}

export async function renameWallet(id: string, name: string): Promise<void> {
  const info = walletInfos.value.find((w) => w.id === id);
  if (!info) return;
  const next = { ...info, name };
  await saveWalletInfo(next);
  const cur = currentWallet.value;
  if (cur?.id === id) (cur.info as WalletInfo).name = name;
}

export async function deleteWallet(id: string): Promise<void> {
  if (currentWallet.value?.id === id) {
    const w = currentWallet.value;
    currentWallet.value = null;
    await w.close().catch(() => {});
  }
  for (const k of await vault.keys(`cache:${id}`)) await vault.del(k);
  await vault.del(SECRETS(id));
  await vault.del(INFO(id));
  walletInfos.value = walletInfos.value.filter((w) => w.id !== id);
  if (settings.value.currentWalletId === id) {
    updateSettings({ currentWalletId: walletInfos.value[0]?.id ?? null });
    if (walletInfos.value[0]) void openWallet(walletInfos.value[0].id).catch(() => {});
  }
}

/** Per-wallet encrypted cache (tx history, addresses, engine state). */
export const walletCache = {
  get<T>(id: string, key: string): Promise<T | undefined> {
    return vault.get<T>(`cache:${id}:${key}`);
  },
  put(id: string, key: string, v: unknown): Promise<void> {
    return vault.put(`cache:${id}:${key}`, v);
  },
};

export const hasWallets = computed(() => walletInfos.value.length > 0);

setEngineContextFactory((info) => ({
  cacheGet: (k) => walletCache.get(info.id, k),
  cachePut: (k, v) => walletCache.put(info.id, k, v),
  saveInfo: (i) => saveWalletInfo(i),
  saveSecrets: (sec) => saveSecrets(info.id, sec),
  node: (pow) => currentNode(info.type, pow),
  settings: () => settings.value,
  scope: `wallet:${info.id}`,
}));

/** Node choices live in the encrypted vault (they can reveal which servers you use). */
export async function loadNodes(): Promise<void> {
  customNodes.value = (await vault.get<typeof customNodes.value>('nodes:custom')) ?? [];
  currentNodeIds.value = (await vault.get<typeof currentNodeIds.value>('nodes:current')) ?? {};
}

export async function saveNodes(): Promise<void> {
  await vault.put('nodes:custom', customNodes.value);
  await vault.put('nodes:current', currentNodeIds.value);
}
