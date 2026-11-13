// History list and transaction details (lib/new-ui/widgets/coins_page/assets_history/*).

import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { t } from '../../../core/i18n.ts';
import { AddressText, Icon, Img, Row, Section, TopBar, copyText } from '../../components/core.tsx';
import { showSheet } from '../../components/overlays.tsx';
import type { TransactionInfo, WalletBase } from '../../../core/wallet.ts';
import { currency, currencyIcon } from '../../../coins/types.ts';
import { formatFixed } from '../../../core/amount.ts';
import { apiString, fiatValue, formatFiatAmount, prices } from '../../../app/prices.ts';
import { settings } from '../../../app/settings.ts';
import { vault } from '../../../core/vault.ts';
import { nav } from '../../nav.ts';
import { isTokenWallet } from '../../../coins/tokens.ts';
import { Routes } from '../../routes.ts';
import { trades } from '../../../exchange/trades.ts';
import { PROVIDERS, type Trade } from '../../../exchange/types.ts';
import { TradeTile } from '../swap/trade.tsx';
import { OrderTile } from '../cakepay/cakepay.tsx';
import { orders, type OrderRecord } from '../../../cakepay/service.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** history_section.dart date format */
export function historyDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return hm;
  if (days === 1) return `${t('yesterday')}, ${hm}`;
  if (days < 7 && days > 0) return `${WEEKDAYS[d.getDay()]}, ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}, ${hm}`;
}

export function detailsDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** formatted_item_list.dart section headers */
export function sectionHeader(ms: number): string {
  const age = Date.now() - ms;
  const today = new Date();
  const d = new Date(ms);
  if (d.toDateString() === today.toDateString()) return t('today');
  if (age < 7 * 86_400_000) return t('last_7_days');
  if (age < 30 * 86_400_000) return t('last_30_days');
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** the details' confirmations row: electrum and EVM wallets, Zcash, Monero (transaction_details_view_model.dart) */
const CONFIRMATION_ROW = new Set(['bitcoin', 'litecoin', 'bitcoinCash', 'dogecoin', 'ethereum', 'polygon', 'base', 'arbitrum', 'bsc', 'robinhood', 'zcash', 'monero']);

/** TransactionDetailsViewModel.neededConfirmations (0: only the count is shown) */
function neededConfirmations(w: WalletBase): number {
  if (w.type === 'monero' || w.type === 'zano') return 10;
  if (w.type === 'wownero') return 3;
  return 0;
}

function confirmationsNeeded(w: WalletBase): number {
  if (w.type === 'monero' || w.type === 'zano') return 10;
  if (w.type === 'wownero') return 3;
  if (w.type === 'litecoin') return 6;
  return 1;
}

export function txTitle(w: WalletBase, tx: TransactionInfo): string {
  const suffix = tx.evmSignatureName === 'approval' ? ' (approval)' : '';
  if (!tx.isPending) return (tx.direction === 'incoming' ? t('received') : t('sent')) + suffix;
  const base = tx.direction === 'incoming' ? t('receiving') : t('sending');
  const need = confirmationsNeeded(w);
  if (need > 1) return `${base} (${tx.confirmations}/${need})${suffix}`;
  return `${base}...${suffix}`;
}

export function txAsset(w: WalletBase, tx: TransactionInfo): { symbol: string; decimals: number; api: string; icon?: string } {
  const c = (() => {
    try {
      return currency(tx.currency);
    } catch {
      return w.currency;
    }
  })();
  if (tx.tokenSymbol) {
    const a = isTokenWallet(w) ? w.assetList().find((x) => x.key === tx.currency) : undefined;
    return { symbol: tx.tokenSymbol, decimals: tx.tokenDecimals ?? a?.decimals ?? c.decimals, api: a?.api ?? apiString(w.currency, tx.extra?.contract), icon: a?.icon ?? tx.extra?.icon };
  }
  return { symbol: c.title, decimals: c.decimals, api: apiString(c), icon: currencyIcon(c) };
}

export function formatTxAmount(w: WalletBase, tx: TransactionInfo): { amount: string; fiat: string } {
  const a = txAsset(w, tx);
  const sats = w.type === 'bitcoin' && settings.value.displayAmountsInSatoshi;
  const amount = sats ? `${tx.amount.toString()} sats` : `${formatFixed(tx.amount, a.decimals, { fractionDigits: Math.min(a.decimals, 12) })} ${a.symbol}`;
  void prices.value;
  const f = fiatValue(Number(formatFixed(tx.amount, a.decimals)), a.api);
  return { amount, fiat: f === null ? '' : `${settings.value.fiatCurrency} ${formatFiatAmount(f)}` };
}

export function HistoryTile({ w, tx, first, last, onClick, hidden }: { w: WalletBase; tx: TransactionInfo; first?: boolean; last?: boolean; onClick?: () => void; hidden?: boolean }) {
  const { amount, fiat } = formatTxAmount(w, tx);
  const icon = tx.isPending ? (tx.direction === 'incoming' ? 'history-receiving.svg' : 'history-sending.svg') : tx.direction === 'incoming' ? 'history-received.svg' : 'history-sent.svg';
  const color = tx.direction === 'incoming' ? 'var(--green)' : 'color-mix(in srgb, var(--on-surface) 69%, transparent)';
  const a = txAsset(w, tx);
  return (
    <button
      type="button"
      class="history-tile"
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', border: 0, background: 'var(--surface-container)', padding: '12px 16px 12px 12px', cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start', borderTopLeftRadius: first ? '22px' : 0, borderTopRightRadius: first ? '22px' : 0, borderBottomLeftRadius: last ? '22px' : 0, borderBottomRightRadius: last ? '22px' : 0, position: 'relative' }}
    >
      {!first && <span style={{ position: 'absolute', top: 0, left: '56px', right: '16px', height: '1px', background: 'color-mix(in srgb, var(--outline-variant) 69%, transparent)' }} />}
      {tx.tokenSymbol && a.icon ? <Img src={a.icon} size={34} round style={{ opacity: tx.isPending ? 0.5 : 1 }} /> : <Icon src={icon} size={36} color={color} />}
      <span class="grow col" style={{ gap: '2px' }}>
        <span>{txTitle(w, tx)}</span>
        <span class="muted">{historyDate(tx.date)}</span>
      </span>
      <span class="col" style={{ alignItems: 'flex-end', gap: '2px' }}>
        <span>{hidden ? '---' : amount}</span>
        <span class="muted">{hidden ? '---' : fiat}</span>
      </span>
    </button>
  );
}

export type HistoryItem = { kind: 'tx'; tx: TransactionInfo } | { kind: 'trade'; trade: Trade } | { kind: 'order'; order: OrderRecord };

/** OrderFilterStore.displayCakePay */
export const orderFilter = signal(true);

/** TradeFilterStore: the providers with a toggle (Jupiter has none), all shown at first */
export const TRADE_FILTER_PROVIDERS = [PROVIDERS.changeNow, PROVIDERS.sideShift, PROVIDERS.simpleSwap, PROVIDERS.trocador, PROVIDERS.exolix, PROVIDERS.chainflip, PROVIDERS.thorChain, PROVIDERS.whyNot, PROVIDERS.stealthEx, PROVIDERS.xoSwap, PROVIDERS.swapTrade, PROVIDERS.swapsXyz, PROVIDERS.nearIntents];
const allTradeFilters = (on: boolean): Record<number, boolean> => Object.fromEntries([...TRADE_FILTER_PROVIDERS, PROVIDERS.xmrto, PROVIDERS.morphToken].map((p) => [p.raw, on]));
export const tradeFilter = signal<Record<number, boolean>>(allTradeFilters(true));
export const tradeFilterCount = () => TRADE_FILTER_PROVIDERS.filter((p) => tradeFilter.value[p.raw]).length;
export const displayAllTrades = () => tradeFilterCount() === TRADE_FILTER_PROVIDERS.length;
/** toggleDisplayExchange(ExchangeProviderDescription.all) */
export function toggleAllTrades(): void {
  tradeFilter.value = allTradeFilters(!displayAllTrades());
}
export function resetTradeFilter(): void {
  tradeFilter.value = allTradeFilters(true);
}

/** DashboardViewModel.trades + TradeFilterStore.filtered: this wallet's trades (same chain, same account) */
export function tradesForWallet(w: WalletBase): Trade[] {
  const chainId = (w as { chainId?: number }).chainId;
  const own = new Set([...w.addresses.value.map((a) => a.address), w.receiveAddress.value]);
  const list = trades.value.filter((x) => x.walletId === w.id && (x.chainId === undefined || x.chainId === null || x.chainId === chainId) && (!x.fromWalletAddress || own.has(x.fromWalletAddress)));
  if (displayAllTrades()) return list;
  // QUIRK: with any toggle off, trades of providers without one (Jupiter) disappear too
  const f = tradeFilter.value;
  return list.filter((x) => f[x.providerRaw] === true);
}

/** formattedItemsList: transactions and trades by date, newest first (pending transactions keep their place on top) */
/** DashboardViewModel.orders + OrderFilterStore.filtered: this wallet's Cake Pay orders */
export function ordersForWallet(w: WalletBase): OrderRecord[] {
  return orderFilter.value ? orders.value.filter((o) => o.walletId === w.id) : [];
}

/** formattedItemsList: transactions, trades and orders by date, newest first (pending transactions keep their place on top) */
export function historyItems(w: WalletBase, txs: TransactionInfo[]): HistoryItem[] {
  const others: HistoryItem[] = [...tradesForWallet(w).map((trade) => ({ kind: 'trade' as const, trade })), ...ordersForWallet(w).map((order) => ({ kind: 'order' as const, order }))].sort((a, b) => itemDate(b) - itemDate(a));
  const out: HistoryItem[] = [];
  let ti = 0;
  for (const tx of txs) {
    while (ti < others.length && !tx.isPending && itemDate(others[ti]) >= tx.date) out.push(others[ti++]);
    out.push({ kind: 'tx', tx });
  }
  while (ti < others.length) out.push(others[ti++]);
  return out;
}

const itemDate = (it: HistoryItem) => (it.kind === 'tx' ? it.tx.date : it.kind === 'trade' ? it.trade.createdAt ?? Date.now() : it.order.createdAt);

export function HistoryList({ w, txs, items: given, grouped, hidden }: { w: WalletBase; txs: TransactionInfo[]; items?: HistoryItem[]; grouped?: boolean; hidden?: boolean }) {
  const items = given ?? historyItems(w, txs);
  const tile = (it: HistoryItem, first: boolean, last: boolean) => (it.kind === 'tx' ? <HistoryTile w={w} tx={it.tx} first={first} last={last} hidden={hidden} onClick={() => openTxDetails(w, it.tx)} /> : it.kind === 'trade' ? <TradeTile trade={it.trade} first={first} last={last} hidden={hidden} /> : <OrderTile order={it.order} first={first} last={last} hidden={hidden} date={historyDate(it.order.createdAt)} />);
  if (!grouped) {
    return <div class="col">{items.map((it, i) => tile(it, i === 0, i === items.length - 1))}</div>;
  }
  const groups: { header: string; items: HistoryItem[] }[] = [];
  for (const it of items) {
    const h = it.kind === 'tx' && it.tx.isPending ? t('today') : sectionHeader(itemDate(it));
    const g = groups[groups.length - 1];
    if (g && g.header === h) g.items.push(it);
    else groups.push({ header: h, items: [it] });
  }
  return (
    <div class="col">
      {groups.map((g, gi) => (
        <div>
          <div class="muted" style={{ padding: `${gi ? 18 : 0}px 0 8px 8px` }}>{g.header}</div>
          {g.items.map((it, i) => tile(it, i === 0, i === g.items.length - 1))}
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------- notes --

export async function getTxNotes(walletId: string): Promise<Record<string, string>> {
  return (await vault.get<Record<string, string>>(`txnotes:${walletId}`)) ?? {};
}

export async function setTxNote(walletId: string, txid: string, note: string): Promise<void> {
  const n = await getTxNotes(walletId);
  if (note) n[txid] = note;
  else delete n[txid];
  await vault.put(`txnotes:${walletId}`, n);
}

export function openTxDetails(w: WalletBase, tx: TransactionInfo) {
  return showSheet((close) => <TxDetails w={w} tx={tx} close={close} />, { full: true });
}

function TxDetails({ w, tx, close }: { w: WalletBase; tx: TransactionInfo; close: () => void }) {
  const [note, setNote] = useState('');
  useEffect(() => {
    void getTxNotes(w.id).then((n) => setNote(n[tx.id] ?? ''));
  }, [tx.id]);
  const a = txAsset(w, tx);
  const { amount } = formatTxAmount(w, tx);
  const explorer = w.explorerUrl(tx.id);
  const rows: { label: string; value: string; mono?: boolean }[] = [];
  rows.push({ label: t('transaction_details_date'), value: detailsDate(tx.date) });
  if (tx.height) rows.push({ label: t('transaction_details_height'), value: String(tx.height) });
  if (tx.fee !== undefined && tx.direction === 'outgoing') rows.push({ label: t('transaction_details_fee'), value: `${formatFixed(tx.fee, w.currency.decimals)} ${w.currency.title}` });
  if (tx.extra?.feeRate) rows.push({ label: 'Fee rate', value: tx.extra.feeRate });
  if (tx.direction === 'outgoing' && tx.outputAddresses?.length) {
    const others = tx.outputAddresses.filter((x) => !w.addresses.value.some((a) => a.address === x));
    if (others.length) rows.push({ label: t('transaction_details_recipient_address'), value: others.join('\n'), mono: true });
  }
  if (tx.from && tx.direction === 'incoming') rows.push({ label: t('transaction_details_source_address'), value: tx.from, mono: true });
  if (tx.direction === 'incoming' && tx.to) rows.push({ label: t('transaction_details_recipient_address'), value: tx.to, mono: true });
  if (tx.key) rows.push({ label: t('transaction_key'), value: tx.key, mono: true });
  if (tx.memo) rows.push({ label: t('memo'), value: tx.memo });
  if (tx.paymentId) rows.push({ label: t('payment_id'), value: tx.paymentId, mono: true });
  if (w.type === 'nano') rows.push({ label: t('confirmed_tx'), value: String(tx.confirmations > 0) });
  rows.push({ label: t('transaction_details_transaction_id'), value: tx.id, mono: true });
  const canBump = (w as any).canReplaceByFee?.(tx.id);
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)', borderRadius: '25px 25px 0 0' }} id="transaction_details">
      <TopBar title={t('transaction')} onClose={close} />
      <div class="page-body" style={{ padding: '0 16px 32px' }}>
        <div class="col" style={{ alignItems: 'center', gap: '10px', paddingBottom: '16px' }}>
          <Img src={a.icon} size={64} round />
          <div style={{ fontSize: '20px', fontWeight: 500 }}>{txTitle(w, tx)}</div>
          <div style={{ fontSize: '28px', cursor: 'pointer' }} onClick={() => void copyText(amount)} id="transaction_details_amount">
            {tx.direction === 'outgoing' ? '-' : '+'}
            {amount}
          </div>
        </div>
        <div class="col gap12">
          <Section>
            {rows.map((r) => (r.value.length <= 25 && !r.mono ? <Row label={r.label} trailingText={r.value} copy={r.value} /> : <Row label={r.label} subtitle={r.mono ? <span class="mono" style={{ fontSize: '12px' }}>{r.value.split('\n').map((v) => <div><AddressText address={v} /></div>)}</span> : r.value} copy={r.value} />))}
            {CONFIRMATION_ROW.has(w.type) && <Row label={t('confirmations')} trailing={<span><span style={{ color: 'var(--primary)' }}>{tx.confirmations}</span>{neededConfirmations(w) > 0 && <span class="muted">/{neededConfirmations(w)}</span>}</span>} />}
          </Section>
          <div style={{ background: 'var(--surface-container)', borderRadius: '20px', padding: '12px' }}>
            <div>{t('note')}</div>
            <textarea class="text-area-plain" style={{ minHeight: '44px', padding: '8px 0', background: 'none' }} placeholder={t('add_a_note')} value={note} id="tx_note" onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} onBlur={() => void setTxNote(w.id, tx.id, note.trim())} />
          </div>
          <Section>
            {explorer && <Row label={<span style={{ color: 'var(--primary)' }}>{`${t('view_transaction_on')}${new URL(explorer).host}`}</span>} onClick={() => openExternal(explorer)} trailing={<Icon src="link_arrow.svg" size={8} color="var(--primary)" />} />}
            {canBump && <Row label={t('bump_fee')} onClick={() => { close(); nav.push(Routes.bumpFeePage, { txid: tx.id }); }} />}
          </Section>
        </div>
      </div>
    </div>
  );
}

/** Opening an outside link leaves Tor: say so first (Cake opens explorers in the browser too). */
export async function openExternal(url: string): Promise<void> {
  const { confirmAlert } = await import('../../components/overlays.tsx');
  const ok = await confirmAlert(t('open_link') === 'open_link' ? 'Open link' : t('open_link'), `${url}\n\nThis opens in your browser, outside this app's Tor connection. Use Tor Browser to keep it private.`, t('open') === 'open' ? 'Open' : t('open'));
  if (ok) window.open(url, '_blank', 'noopener,noreferrer');
}
