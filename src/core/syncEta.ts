// The ETA of a sync (cw_core/lib/sync_status.dart, SyncingSyncStatus's statics; the reactions in
// lib/reactions/on_wallet_sync_status_change.dart): the blocks left over time, a rate weighted toward
// the latest steps, a smoothed remaining time.

/** blockHistory: [time ms, blocks left] */
const history: [number, number][] = [];
let startedAt: number | null = null;
let lastEta: number | null = null;
const MIN_POINTS = 3;

/** a SyncingSyncStatus was made: updateEtaHistory, and the sync's start */
export function noteSyncing(blocksLeft: number, now = Date.now()): void {
  history.push([now, blocksLeft]);
  startedAt ??= now;
}

/** resetSyncStartTime (connected, synced, failed) */
export function resetSyncStart(): void {
  startedAt = null;
}

/** blockHistory.clear() (synced, another node) */
export function clearSyncHistory(): void {
  history.length = 0;
}

/** shouldShowBlocksRemaining: the first 15 seconds of a sync */
export function showBlocksRemaining(now = Date.now()): boolean {
  return startedAt === null || now - startedAt < 15_000;
}

/** _calculateBlockRate: blocks per ms, later steps weighing more */
function blockRate(): number {
  const data = [...history].sort((a, b) => a[0] - b[0]);
  if (data.length < 2) return 0;
  let time = 0;
  let blocks = 0;
  let weights = 0;
  for (let i = 0; i < data.length - 1; i++) {
    const done = data[i][1] - data[i + 1][1];
    if (done <= 0) continue;
    const dt = data[i + 1][0] - data[i][0];
    if (dt <= 0) continue;
    const w = 1 / (1 + (data.length - 1 - i) * 0.1);
    time += dt * w;
    blocks += done * w;
    weights += w;
  }
  if (!weights || !time) return 0;
  return blocks / time;
}

/** _applySmoothing: a large jump moves at most 30 min, a medium one 2 min, a small one 30 s */
function smooth(ms: number): number {
  if (lastEta === null) return ms;
  const diff = Math.abs((ms - lastEta) / 1000);
  const dir = ms > lastEta ? 1 : -1;
  if (diff > 3600) return lastEta + dir * 30 * 60_000;
  if (diff > 300) return lastEta + dir * 2 * 60_000;
  if (diff > 60) return lastEta + dir * 30_000;
  return ms;
}

/** _formatDuration */
export function formatEta(ms: number): string {
  const total = Math.trunc(ms / 1000);
  const h = Math.trunc(total / 3600);
  const m = Math.trunc(total / 60) % 60;
  const s = total % 60;
  if (!m && !h) return `${s}s`;
  if (!h) return `${m}min ${s}s`;
  return `${h}h ${m}min ${s}s`;
}

/** getFormattedEtaWithPlaceholder: the remaining time, or "Syncing..." while there is too little to go on */
export function etaText(blocksLeft: number): string {
  if (history.length >= MIN_POINTS) {
    const rate = blockRate();
    // calculateEta: no rate is two days away
    let ms = rate === 0 ? 2 * 86_400_000 : Math.round(blocksLeft / rate);
    // getFormattedEta: nothing for a day or more, or under 100 blocks
    if (ms < 86_400_000 && blocksLeft >= 100) {
      ms = smooth(ms);
      lastEta = ms;
      return formatEta(ms);
    }
  }
  return 'Syncing...';
}
