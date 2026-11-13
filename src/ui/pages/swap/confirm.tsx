// After a trade is created: SwapConfirmSheet (lib/new-ui/widgets/swap_page/swap_confirm_sheet.dart,
// ExchangeTradeViewModel) — the trade, the transaction that pays it, swipe to
// send — and SwapSendExternalModal (swap_send_external_modal.dart) for paying
// it from another wallet.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../../core/i18n.ts';
import { AddressText, Button, Icon, Img, MIcon, ModernButton, Spinner, TopBar, copyText } from '../../components/core.tsx';
import { showSheet } from '../../components/overlays.tsx';
import { QrCode, qrBadge } from '../../components/qr.tsx';
import { nav } from '../../nav.ts';
import { settings } from '../../../app/settings.ts';
import { fiatValue, formatFiatAmount, apiString } from '../../../app/prices.ts';
import type { PendingTransaction } from '../../../core/wallet.ts';
import { formatFixed } from '../../../core/amount.ts';
import type { ExchangeVM } from '../../../exchange/exchange.ts';
import { memoLabelType, walletTypeOf, type SwapCurrency } from '../../../exchange/currency.ts';
import { withMaxDecimals } from '../../../exchange/amounts.ts';
import { buildSwapTransaction } from '../../../exchange/send.ts';
import { paymentUri } from '../../../exchange/uri.ts';
import { findTrade, refreshTrade, trades } from '../../../exchange/trades.ts';
import { providerByRaw, PROVIDERS, type Trade } from '../../../exchange/types.ts';
import { providerForRaw } from '../../../exchange/providers/index.ts';
import { ConfirmSwiper } from '../send.tsx';
import { badgeFor, middleTruncate } from './util.ts';

/** a trade's status every 20 s while its sheet or page is open (stopped when it closes, unlike Cake) */
export function useTradePolling(id: string): void {
  useEffect(() => {
    const t0 = findTrade(id);
    if (!t0 || !providerForRaw(t0.providerRaw)) return;
    const tick = () => void refreshTrade(id).catch(() => {});
    tick();
    const h = setInterval(tick, 20_000);
    return () => clearInterval(h);
  }, [id]);
}

/** SwapModalHeader: the two coins and "Swap" */
function SwapHeader({ from, to }: { from: SwapCurrency; to: SwapCurrency }) {
  return (
    <span class="rowx" style={{ gap: '8px' }}>
      <span style={{ position: 'relative', width: '36px', height: '36px', flex: 'none' }}>
        <Img src={from.iconPath ?? undefined} size={24} round />
        <span style={{ position: 'absolute', top: '12px', left: '12px' }}><Img src={to.iconPath ?? undefined} size={24} round /></span>
      </span>
      <span style={{ fontSize: '20px', fontWeight: 500 }}>{t('swap')}</span>
    </span>
  );
}

function ListSection({ header, children }: { header: string; children: ComponentChildren }) {
  return (
    <div class="col" style={{ gap: '8px' }}>
      <div style={{ fontSize: '14px', color: 'var(--on-surface-variant)', paddingLeft: '4px' }}>{header}</div>
      <div style={{ background: 'var(--surface-container)', borderRadius: '16px', overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

function Line({ label, icon, badge, trailing, onClick, bottom, first, id }: { label: string; icon?: string; badge?: string | null; trailing?: ComponentChildren; onClick?: () => void; bottom?: ComponentChildren; first?: boolean; id?: string }) {
  return (
    <>
      {!first && <div style={{ height: '1px', margin: '0 16px', background: 'var(--surface-container-high)' }} />}
      <div id={id} onClick={onClick} style={{ padding: '14px 16px', cursor: onClick ? 'pointer' : 'default' }}>
        <div class="rowx" style={{ gap: '12px', justifyContent: 'space-between' }}>
          <span class="rowx" style={{ gap: '10px', minWidth: 0 }}>
            {icon && (
              <span style={{ position: 'relative', flex: 'none', display: 'flex' }}>
                <Img src={icon} size={24} round />
                {badge && <span style={{ position: 'absolute', right: '-3px', bottom: '-3px', width: '12px', height: '12px', padding: '3px', boxSizing: 'border-box', borderRadius: '4px', background: 'var(--on-surface)', display: 'flex' }}><Icon src={badge} size={6} color="var(--surface)" /></span>}
              </span>
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
          </span>
          <span class="rowx" style={{ gap: '6px', color: 'var(--on-surface-variant)', textAlign: 'end', minWidth: 0, overflowWrap: 'anywhere' }}>{trailing}</span>
        </div>
        {bottom}
      </div>
    </>
  );
}

type SendState = 'idle' | 'generating' | 'ready' | 'sending' | 'committed' | 'error';

/** open the confirm sheet for a new trade; closing it closes the swap page too */
export async function openSwapConfirm(vm: ExchangeVM, trade: Trade, receiveAmount: string): Promise<void> {
  await showSheet<void>((close) => <ConfirmSheet vm={vm} tradeId={trade.id} initial={trade} receiveAmount={receiveAmount} close={() => close()} />, { dismissible: false });
  // the sheet lives in the swap modal's navigator: closing it pops the whole swap screen
  nav.pop();
}

function ConfirmSheet({ vm, tradeId, initial, receiveAmount, close }: { vm: ExchangeVM; tradeId: string; initial: Trade; receiveAmount: string; close: () => void }) {
  void trades.value;
  const trade = findTrade(tradeId) ?? initial;
  useTradePolling(tradeId);
  const external = vm.isSendFromExternal.value;
  const [state, setState] = useState<SendState>(external ? 'idle' : 'generating');
  const [pending, setPending] = useState<PendingTransaction | null>(null);
  const [error, setError] = useState('');
  const closed = useRef(false);
  const w = vm.wallet;
  useEffect(() => {
    if (external) return;
    // confirmSending
    buildSwapTransaction(w, trade)
      .then((p) => {
        setPending(p);
        setState('ready');
      })
      .catch((e) => {
        setError((e as Error).message);
        setState('error');
      });
  }, []);
  useEffect(() => {
    if (state !== 'committed') return;
    const h = setTimeout(() => {
      if (!closed.current) close();
    }, 2000);
    return () => clearTimeout(h);
  }, [state]);
  const from = trade.from ?? vm.depositCurrency.value;
  const to = trade.to ?? vm.receiveCurrency.value;
  const provider = providerByRaw(trade.providerRaw);
  const fiatCode = settings.value.fiatCurrency;
  const feeFiat = pending ? fiatValue(Number(formatFixed(pending.fee, w.currency.decimals)), apiString(w.currency)) : null;
  const memo = memoLabelType(to);
  const idLong = trade.id.length > 18;
  const doClose = () => {
    closed.current = true;
    close();
  };
  if (state === 'committed') {
    return (
      <div class="col" style={{ background: 'var(--surface)', borderRadius: '30px 30px 0 0', padding: '24px', gap: '12px', alignItems: 'center' }} id="swap_transaction_sent">
        <div style={{ fontSize: '24px', fontWeight: 600 }} role="status">{t('transaction_sent_new')}</div>
        <Img src="assets/new-ui/birthday_cake.svg" size={200} />
        <Button onClick={doClose}>{t('done')}</Button>
      </div>
    );
  }
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '30px 30px 0 0', maxHeight: '92vh' }} id="swap_confirm_sheet">
      <TopBar leading={<SwapHeader from={from} to={to} />} trailing={state !== 'sending' ? <ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} onClick={doClose} /> : undefined} />
      <div class="col" style={{ gap: '24px', padding: '0 16px 16px', overflowY: 'auto' }}>
        <ListSection header={t('send')}>
          <Line first label={from.fullName ?? from.title} icon={from.iconPath ?? undefined} badge={badgeFor(from)} trailing={<span id="swap_confirm_send_amount">{`${trade.amount} ${from.title}`}</span>} />
          {pending && <Line label={t('fee')} trailing={<span id="swap_confirm_fee">{`${pending.feeFormatted} ${w.currency.title}${feeFiat !== null && settings.value.fiatApiMode !== 'disabled' ? ` (${formatFiatAmount(feeFiat)} ${fiatCode})` : ''}`}</span>} />}
          <Line label={t('from')} trailing={external ? t('external_wallet') : w.name} />
        </ListSection>
        <ListSection header={t('receive')}>
          <Line first label={to.fullName ?? to.title} icon={to.iconPath ?? undefined} badge={badgeFor(to)} trailing={<span id="swap_confirm_receive_amount">{`${withMaxDecimals(receiveAmount, 8)} ${to.title}`}</span>} />
          <Line label={t('to')} trailing={vm.receiveAddressDisplayName.value ?? middleTruncate(trade.payoutAddress ?? '', 8, 8)} />
          {!!trade.toAddressExtraId && <Line label={memo === 'destinationTag' ? t('destination_tag') : t('memo')} trailing={middleTruncate(trade.toAddressExtraId, 8, 8)} onClick={() => void copyText(trade.toAddressExtraId!)} />}
        </ListSection>
        <ListSection header={`${t('swap_id')} (${t('tap_to_copy')})`}>
          <Line
            first
            id="swap_confirm_id"
            label={provider?.title ?? ''}
            icon={provider?.image}
            onClick={() => void copyText(trade.id)}
            trailing={
              <>
                {!idLong && <span>{trade.id}</span>}
                <Icon src="copy.svg" size={16} color="var(--on-surface-variant)" />
              </>
            }
            bottom={idLong ? <div style={{ paddingTop: '12px', color: 'var(--on-surface-variant)', overflowWrap: 'anywhere' }}>{trade.id}</div> : undefined}
          />
          {trade.providerRaw === PROVIDERS.trocador.raw && <Line label={`Trocador ${t('provider')}`} trailing={trade.providerName ?? ''} />}
        </ListSection>
        <div style={{ paddingBottom: '8px' }}>
          {external ? (
            <Button id="swap_confirm_continue" onClick={() => void openSendExternal(trade, from)}>{t('continue_text')}</Button>
          ) : (
            <SendBottom state={state} error={error} onConfirm={async () => {
              if (!pending) return;
              setState('sending');
              try {
                await pending.commit();
                setState('committed');
              } catch (e) {
                setError((e as Error).message);
                setState('error');
              }
            }} onClose={doClose} />
          )}
        </div>
      </div>
    </div>
  );
}

/** SendConfirmBottomWidget */
function SendBottom({ state, error, onConfirm, onClose }: { state: SendState; error: string; onConfirm: () => void; onClose: () => void }) {
  if (state === 'generating') return <div class="rowx" style={{ justifyContent: 'center', gap: '12px', color: 'var(--on-surface-variant)', padding: '16px 0' }}><Spinner /> {`${t('generating_transaction')}...`}</div>;
  if (state === 'sending') return <div class="rowx" style={{ justifyContent: 'center', gap: '12px', color: 'var(--on-surface-variant)', padding: '16px 0' }}><Spinner /> {`${t('sending')}...`}</div>;
  if (state === 'error') {
    return (
      <div class="col gap12">
        <div style={{ background: 'color-mix(in srgb, var(--error-container) 25%, transparent)', borderRadius: '16px', padding: '12px', color: 'var(--error)' }} id="swap_send_error">
          <div class="rowx gap8"><Icon src="warning.svg" size={24} color="var(--error)" /><span style={{ fontSize: '16px' }}>{t('transaction_error')}</span></div>
          <div class="center" style={{ marginTop: '8px', overflowWrap: 'anywhere' }}>{error}</div>
        </div>
        <Button onClick={onClose}>{t('close')}</Button>
      </div>
    );
  }
  if (state === 'ready') return <ConfirmSwiper label={t('swipe_to_send')} onConfirm={onConfirm} />;
  return null;
}

// ------------------------------------------------------- external send --

function openSendExternal(trade: Trade, from: SwapCurrency): Promise<void> {
  return showSheet<void>((close) => <SendExternal tradeId={trade.id} initial={trade} from={from} close={() => close()} />).then(() => {});
}

function SendExternal({ tradeId, initial, from, close }: { tradeId: string; initial: Trade; from: SwapCurrency; close: () => void }) {
  void trades.value;
  const trade = findTrade(tradeId) ?? initial;
  const [large, setLarge] = useState(false);
  const [copied, setCopied] = useState(false);
  const uri = paymentUri(trade);
  const address = trade.inputAddress ?? '';
  const size = Math.round(Math.min(window.innerWidth, 560) * (large ? 0.8 : 0.54));
  const wt = walletTypeOf(from);
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', maxHeight: '92vh' }} id="swap_send_external">
      <TopBar title="" trailing={<ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} onClick={close} />} />
      <div class="col" style={{ padding: '0 16px 24px', gap: '16px', alignItems: 'center', overflowY: 'auto' }}>
        <div class="rowx" style={{ gap: '8px', flexWrap: 'wrap', justifyContent: 'center', fontSize: '16px', fontWeight: 500 }}>
          <span>{t('send_exactly')}</span>
          <span style={{ background: 'var(--surface-container)', borderRadius: '12px', padding: '8px', color: 'var(--primary)' }} id="swap_external_amount">
            <span style={{ fontWeight: 500 }}>{trade.amount}</span> <span style={{ fontWeight: 400 }}>{from.title}</span>
          </span>
          <span>{`${t('to')}:`}</span>
        </div>
        {uri && (
          <button type="button" onClick={() => setLarge(!large)} style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', transition: 'width 200ms' }} aria-label="QR code">
            <QrCode data={uri} size={size} logo={qrBadge(wt)} id="swap_external_qr" />
          </button>
        )}
        <div class="mono center" style={{ fontSize: '14px', overflowWrap: 'anywhere' }} id="swap_external_address"><AddressText address={address} /></div>
        <div style={{ background: 'color-mix(in srgb, #FFB84E 18%, var(--surface-container))', borderRadius: '16px', padding: '20px', color: '#FFB84E', fontSize: '14px', fontWeight: 500, textAlign: 'center' }}>{t('send_external_desc')}</div>
        {trade.extraId != null && (
          <button type="button" onClick={async () => { await copyText(trade.extraId!); setCopied(true); setTimeout(() => setCopied(false), 1500); }} style={{ width: '100%', border: 0, borderRadius: '12px', background: 'var(--surface-container)', padding: '16px', textAlign: 'start', cursor: 'pointer' }} id="swap_external_extra_id">
            <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--on-surface-variant)' }}>{t('destination_tag')}</div>
            <div class="rowx" style={{ justifyContent: 'space-between', marginTop: '6px' }}>
              <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--primary)', overflowWrap: 'anywhere' }}>{trade.extraId}</span>
              {copied ? <MIcon name="check" size={20} color="var(--primary)" /> : <Icon src="copy.svg" size={20} color="var(--primary)" />}
            </div>
          </button>
        )}
        <div class="rowx" style={{ gap: '12px', width: '100%' }}>
          <div class="grow"><Button id="swap_external_copy" onClick={() => void copyText(address)}>{t('copy')}</Button></div>
          <div class="grow"><Button secondary id="swap_external_sent" onClick={close}>{t('sent_the_funds')}</Button></div>
        </div>
      </div>
    </div>
  );
}
