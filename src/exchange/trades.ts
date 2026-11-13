// Trades (lib/store/dashboard/trades_store.dart, Trade table in cake.db) kept
// encrypted in the vault, and TradeMonitor (lib/core/trade_monitor.dart): the
// current wallet's trades of the last 24 h get a status update right away and
// every 5 minutes, until they reach a final state.

import { signal } from '@preact/signals';
import { vault } from '../core/vault.ts';
import { settings } from '../app/settings.ts';
import { providerForRaw } from './providers/index.ts';
import { FINAL_STATES, mergeTrade, type Trade } from './types.ts';

const KEY = 'trades';
const UPDATED_KEY = 'trades:updatedAt';
const CHECK_MINUTES = 5;
const MAX_AGE_HOURS = 24;

/** every trade, newest first (Trade.getAll orders by createdAt DESC) */
export const trades = signal<Trade[]>([]);

let loaded = false;

function sortTrades(list: Trade[]): Trade[] {
  return [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function loadTrades(): Promise<void> {
  trades.value = sortTrades((await vault.get<Trade[]>(KEY)) ?? []);
  loaded = true;
}

export function unloadTrades(): void {
  stopTradeMonitoring();
  trades.value = [];
  loaded = false;
}

/** Trade.save: insert or replace (the id is unique) */
export async function saveTrade(t: Trade): Promise<void> {
  if (!loaded) await loadTrades();
  trades.value = sortTrades([t, ...trades.value.filter((x) => x.id !== t.id)]);
  await vault.put(KEY, trades.value);
}

export function findTrade(id: string): Trade | undefined {
  return trades.value.find((t) => t.id === id);
}

/** import from a backup: the trades this device does not have yet */
export async function importTrades(list: Trade[]): Promise<void> {
  if (!loaded) await loadTrades();
  const have = new Set(trades.value.map((t) => t.id));
  trades.value = sortTrades([...trades.value, ...list.filter((t) => t?.id && !have.has(t.id))]);
  await vault.put(KEY, trades.value);
}

/** _updateTrade: findTradeById, merged into the stored trade; the result (or null when the provider can't tell) */
export async function refreshTrade(id: string): Promise<Trade | null> {
  const t = findTrade(id);
  if (!t) return null;
  const p = providerForRaw(t.providerRaw);
  if (!p) return null;
  const updated = await p.findTradeById(t.id);
  const merged = mergeTrade(findTrade(id) ?? t, updated);
  await saveTrade(merged);
  return merged;
}

// ---------------------------------------------------------------- monitor --

const timers = new Map<string, ReturnType<typeof setInterval>>();
let monitoredWallet: string | null = null;

function permitted(): boolean {
  const s = settings.value;
  return !s.disableAutomaticExchangeStatusUpdates && s.exchangeStatus !== 'disabled';
}

function shouldSkip(t: Trade, walletId: string): boolean {
  if (t.walletId !== walletId) return true;
  if (t.createdAt === undefined) return true;
  if (Math.floor((Date.now() - t.createdAt) / 3_600_000) > MAX_AGE_HOURS) return true;
  if (FINAL_STATES.has(t.stateRaw)) return true;
  const p = providerForRaw(t.providerRaw);
  if (!p) return true;
  if (settings.value.exchangeStatus === 'torOnly' && !p.supportsOnionAddress) return true;
  return false;
}

async function check(id: string): Promise<void> {
  const stamps = (await vault.get<Record<string, number>>(UPDATED_KEY)) ?? {};
  const last = stamps[id];
  if (last && Math.floor((Date.now() - last) / 60_000) < CHECK_MINUTES) return;
  try {
    const merged = await refreshTrade(id);
    if (!merged) return;
    const now = (await vault.get<Record<string, number>>(UPDATED_KEY)) ?? {};
    now[id] = Date.now();
    await vault.put(UPDATED_KEY, now);
    if (FINAL_STATES.has(merged.stateRaw)) cancel(id);
  } catch { /* next time */ }
}

function cancel(id: string): void {
  const t = timers.get(id);
  if (t) clearInterval(t);
  timers.delete(id);
}

/** monitorActiveTrades */
export function monitorActiveTrades(walletId: string | null | undefined): void {
  if (!walletId) return;
  if (monitoredWallet !== walletId) stopTradeMonitoring();
  monitoredWallet = walletId;
  if (!permitted()) return;
  for (const t of trades.value) {
    if (shouldSkip(t, walletId)) {
      cancel(t.id);
      continue;
    }
    if (timers.has(t.id)) continue;
    timers.set(t.id, setInterval(() => void check(t.id), CHECK_MINUTES * 60_000));
    void check(t.id);
  }
}

export function stopTradeMonitoring(): void {
  for (const id of [...timers.keys()]) cancel(id);
}

/** root.dart: stopped while the app is in the background, resumed in the foreground */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopTradeMonitoring();
    else if (monitoredWallet) monitorActiveTrades(monitoredWallet);
  });
}
