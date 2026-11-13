// Bridge transfers (lib/entities/bridge_transfer.dart, lib/store/bridge_transfers_store.dart,
// lib/core/layerzero_scan_service.dart, the polling of bridge_view_model.dart):
// the records, kept encrypted; the source transaction's receipt every 2 s for
// 5 minutes, then LayerZero Scan every 5 s for 10 minutes until delivered.

import { signal } from '@preact/signals';
import { vault } from '../core/vault.ts';
import { request } from '../net/http.ts';

export type BridgeStatus = 'submitted' | 'confirming' | 'initiated' | 'completed' | 'failed';

export interface BridgeTransfer {
  id: string;
  walletId: string;
  sourceChainId: number;
  destinationChainId: number;
  tokenSymbol: string;
  tokenContract: string;
  /** as entered */
  amount: string;
  recipientAddress: string;
  sourceTxHash: string;
  status: BridgeStatus | string;
  createdAt: number;
  updatedAt?: number;
  confirmedAt?: number;
  errorMessage?: string;
  statusMessage?: string;
}

const KEY = 'bridgeTransfers';
export const bridgeTransfers = signal<BridgeTransfer[]>([]);

export const isActive = (t: BridgeTransfer) => t.status === 'submitted' || t.status === 'confirming' || t.status === 'initiated';

/** TransferHistoryRow._statusLabel */
export function bridgeStatusLabel(status: string): string {
  switch (status) {
    case 'submitted': return 'Submitted';
    case 'confirming': return 'Confirming on source';
    case 'initiated': return 'Bridge initiated';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    default: return status;
  }
}

const byDate = (l: BridgeTransfer[]) => [...l].sort((a, b) => b.createdAt - a.createdAt);

export async function loadBridgeTransfers(): Promise<void> {
  bridgeTransfers.value = byDate((await vault.get<BridgeTransfer[]>(KEY)) ?? []);
}

export function unloadBridgeTransfers(): void {
  cancelBridgePolling();
  bridgeTransfers.value = [];
}

async function save(t: BridgeTransfer): Promise<void> {
  bridgeTransfers.value = byDate([t, ...bridgeTransfers.value.filter((x) => x.id !== t.id)]);
  await vault.put(KEY, bridgeTransfers.value);
}

export const addBridgeTransfer = (t: BridgeTransfer) => save(t);

// ------------------------------------------------------------ LayerZero --

export interface LayerZeroStatus {
  status?: { name?: string; message?: string };
  destination?: { status?: string };
}

/** LayerZeroMessageStatus.isDelivered / isFailed */
export const lzDelivered = (s: LayerZeroStatus) => s.status?.name === 'DELIVERED' || s.destination?.status === 'DELIVERED' || s.destination?.status === 'SUCCEEDED';
export const lzFailed = (s: LayerZeroStatus) => s.status?.name === 'FAILED' || s.destination?.status === 'FAILED';

/** the first message of the answer (a list, { data: [...] }, or the message itself) */
export function lzMessage(decoded: unknown): LayerZeroStatus | null {
  if (Array.isArray(decoded)) return (decoded[0] as LayerZeroStatus) ?? null;
  if (decoded && typeof decoded === 'object') {
    const d = (decoded as { data?: unknown }).data;
    if (Array.isArray(d)) return (d[0] as LayerZeroStatus) ?? null;
    return decoded as LayerZeroStatus;
  }
  return null;
}

/** LayerZeroScanService.getMessageStatus: null when there is none (yet) */
export async function layerZeroStatus(sourceTxHash: string, scope: string): Promise<LayerZeroStatus | null> {
  try {
    const r = await request(`https://scan.layerzero-api.com/v1/messages/tx/${sourceTxHash}`, undefined, { scope, timeoutMs: 45_000, retries: 1, okStatuses: [404], purpose: 'bridge status' });
    if (r.status !== 200) return null;
    return lzMessage(JSON.parse(new TextDecoder().decode(r.body)));
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- polling --

export interface ReceiptWallet {
  id: string;
  transactionReceipt(hash: string): Promise<boolean | null>;
}

const pollers = new Map<string, { cancelled: boolean }>();
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function update(t: BridgeTransfer, patch: Partial<BridgeTransfer>): Promise<BridgeTransfer> {
  const cur = bridgeTransfers.value.find((x) => x.id === t.id) ?? t;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await save(next);
  return next;
}

/** _pollForConfirmation: the source receipt (2 s, 5 min), then the LayerZero message (5 s, 10 min) */
export async function pollBridgeTransfer(t: BridgeTransfer, w: ReceiptWallet, isSource: boolean): Promise<void> {
  const key = isSource ? t.id : `${t.id}_dest`;
  if (pollers.has(key)) return;
  const me = { cancelled: false };
  pollers.set(key, me);
  const deadline = Date.now() + (isSource ? 5 : 10) * 60_000;
  try {
    while (Date.now() < deadline) {
      await sleep(isSource ? 2_000 : 5_000);
      if (me.cancelled) return;
      if (isSource) {
        const ok = await w.transactionReceipt(t.sourceTxHash).catch(() => null);
        if (ok === null) continue;
        const next = await update(t, ok ? { status: 'initiated', confirmedAt: Date.now() } : { status: 'failed', errorMessage: 'Transaction reverted' });
        if (ok) {
          await sleep(1_000);
          if (!me.cancelled) void pollBridgeTransfer(next, w, false);
        }
        return;
      }
      const s = await layerZeroStatus(t.sourceTxHash, `wallet:${w.id}`);
      if (!s) continue;
      const failed = lzFailed(s);
      const status = lzDelivered(s) ? 'completed' : failed ? 'failed' : (bridgeTransfers.value.find((x) => x.id === t.id) ?? t).status;
      await update(t, { status, ...(failed ? { errorMessage: s.status?.message ?? 'Bridge message failed' } : {}), ...(s.status?.message ? { statusMessage: s.status.message } : {}) });
      if (lzDelivered(s) || failed) return;
    }
    if (isSource && !me.cancelled) await update(t, { status: 'failed', errorMessage: 'Source confirmation timed out' });
  } finally {
    if (pollers.get(key) === me) pollers.delete(key);
  }
}

/** _resumePollingForActiveTransfers: the wallet's transfers still on their way */
export function resumeBridgePolling(w: ReceiptWallet): void {
  for (const t of bridgeTransfers.value.filter((x) => x.walletId === w.id && isActive(x))) {
    void pollBridgeTransfer(t, w, t.status !== 'initiated');
  }
}

/** _cancelAllPolling */
export function cancelBridgePolling(): void {
  for (const p of pollers.values()) p.cancelled = true;
  pollers.clear();
}
