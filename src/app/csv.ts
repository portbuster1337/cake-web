// History CSV export (lib/core/csv_export_service.dart): one row per
// transaction and per swap, Cake's columns, cells that a spreadsheet would run
// as formulas neutralized, UTF-8 BOM.

import { formatFixed } from '../core/amount.ts';
import type { TransactionInfo, WalletBase } from '../core/wallet.ts';
import { stateOf, providerByRaw, type Trade } from '../exchange/types.ts';

export const CSV_COLUMNS = ['record_type', 'date_time', 'type', 'amount', 'currency', 'fee', 'tx_id', 'address', 'status', 'note', 'from_amount', 'from_currency', 'to_amount', 'to_currency', 'trade_id', 'provider', 'confirmations'];

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function neutralize(f: string): string {
  if (!f || !FORMULA_TRIGGERS.has(f[0])) return f;
  if (PLAIN_NUMBER.test(f)) return f;
  return `'${f}`;
}

/** escapeField */
export function csvField(field: string): string {
  const v = neutralize(field);
  return /[,"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const row = (fields: string[]) => fields.map(csvField).join(',');
/** DateTime.toUtc().toIso8601String(): milliseconds, "Z" */
const iso = (ms: number) => new Date(ms).toISOString();

export type CsvItem = { kind: 'tx'; tx: TransactionInfo; amount: string; symbol: string; note: string } | { kind: 'trade'; trade: Trade };

function txRow(w: WalletBase, it: Extract<CsvItem, { kind: 'tx' }>): string {
  const tx = it.tx;
  const address = tx.direction === 'incoming' ? (tx.from || tx.inputAddresses?.[0] || '') : (tx.to || tx.outputAddresses?.[0] || '');
  const fee = tx.fee !== undefined && tx.fee !== 0n ? formatFixed(tx.fee, w.currency.decimals) : '';
  return row(['transaction', iso(tx.date), tx.direction === 'incoming' ? 'incoming' : 'outgoing', it.amount, it.symbol, fee, tx.id, address, tx.isPending ? 'pending' : 'confirmed', it.note, '', '', '', '', '', '', String(tx.confirmations)]);
}

function tradeRow(t: Trade): string {
  return row(['trade', iso(t.createdAt ?? 0), 'swap', '', '', t.fee !== undefined ? String(t.fee) : '', t.outputTransaction ?? '', t.payoutAddress ?? '', stateOf(t.stateRaw).title, t.memo ?? '', t.amount, t.from?.name ?? '', t.receiveAmount ?? '', t.to?.name ?? '', t.id, providerByRaw(t.providerRaw)?.title ?? '', '']);
}

/** buildCsvContent */
export function buildCsv(w: WalletBase, items: CsvItem[]): string {
  const lines = [CSV_COLUMNS.join(','), ...items.map((it) => (it.kind === 'tx' ? txRow(w, it) : tradeRow(it.trade)))];
  return `\uFEFF${lines.join('\n')}\n`;
}

/** cake_wallet_export_yyyyMMdd_HHmmss.csv */
export function csvFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `cake_wallet_export_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
}
