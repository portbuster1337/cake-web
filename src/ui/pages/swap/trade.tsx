// Trade Details (lib/src/screens/trade_details/trade_details_page.dart,
// lib/view_model/trade_details_view_model.dart) and the history row of a swap
// (lib/new-ui/widgets/coins_page/assets_history/history_trade_tile.dart).

import { t } from '../../../core/i18n.ts';
import { Icon, Img, Page, copyText } from '../../components/core.tsx';
import { toast } from '../../components/overlays.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { builtinOf, memoLabelType } from '../../../exchange/currency.ts';
import { withMaxDecimals } from '../../../exchange/amounts.ts';
import { findTrade, trades } from '../../../exchange/trades.ts';
import { formatTradeAmount, providerByRaw, PROVIDERS, stateOf, type Trade } from '../../../exchange/types.ts';
import { providerForRaw } from '../../../exchange/providers/index.ts';
import { useTradePolling } from './confirm.tsx';
import { badgeFor } from './util.ts';
import { historyDate } from '../dashboard/history.tsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');

/** DateFormatter.withCurrentLocal(reverse: true): "HH:mm  MMMM d, yyyy" */
function createdText(ms: number | undefined): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}  ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function DetailRow({ label, value, id, onLaunch }: { label: string; value: string; id?: string; onLaunch?: () => void }) {
  return (
    <div class="col" style={{ padding: '14px 24px', gap: '6px', borderBottom: '1px solid var(--surface-container-high)' }} id={id}>
      <span class="muted" style={{ fontSize: '14px' }}>{label}</span>
      <span class="rowx" style={{ gap: '10px', justifyContent: 'space-between' }}>
        <button type="button" onClick={() => void copyText(value)} style={{ border: 0, background: 'none', padding: 0, textAlign: 'start', color: 'var(--on-surface)', fontSize: '16px', overflowWrap: 'anywhere', cursor: 'pointer' }}>{value}</button>
        {onLaunch && <button type="button" aria-label={t('track')} onClick={onLaunch} style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', flex: 'none' }}><Icon src="link_arrow.svg" size={16} color="var(--primary)" /></button>}
      </span>
    </div>
  );
}

function TradeDetailsPage({ args }: { args: { id: string } }) {
  void trades.value;
  const trade = findTrade(args.id);
  useTradePolling(args.id);
  if (!trade) return null;
  const desc = providerByRaw(trade.providerRaw);
  const provider = providerForRaw(trade.providerRaw);
  const state = stateOf(trade.stateRaw);
  const fromKey = builtinOf(trade.from)?.key;
  const extraIdTitle = fromKey === 'xrp' ? t('destination_tag') : fromKey === 'xlm' ? t('memo') : t('extra_id');
  const track = provider?.trackUrl(trade);
  return (
    <Page title={t('trade_details_title')} legacy id="trade_details_page" bodyClass="">
      <div class="col">
        {!provider && <div style={{ padding: '14px 24px', color: 'var(--error)' }}>{t('exchange_provider_unsupported', { providerName: desc?.title ?? '' })}</div>}
        <div class="col" style={{ padding: '14px 24px', gap: '6px', borderBottom: '1px solid var(--surface-container-high)' }} id="trade_status">
          <span class="muted" style={{ fontSize: '14px' }}>{t('trade_details_state')}</span>
          <span style={{ fontSize: '16px' }}>{state.title}</span>
        </div>
        {trade.from && trade.to && (
          <div style={{ padding: '12px 24px' }}>
            <button type="button" id="trade_card" onClick={() => { void navigator.clipboard?.writeText(trade.id).catch(() => {}); toast(t('copied_to_clipboard')); }} class="col" style={{ width: '100%', border: 0, borderRadius: '15px', padding: '16px 20px', background: 'var(--surface-container-highest)', color: 'var(--on-surface)', textAlign: 'start', cursor: 'pointer', gap: 0 }}>
              <span style={{ fontSize: '16px', fontWeight: 600, overflowWrap: 'anywhere' }}>{`${t('trade_details_id')}  ${trade.id}`}</span>
              <span style={{ height: '8px' }} />
              {trade.extraId ? <span style={{ fontSize: '16px', paddingBottom: '8px', overflowWrap: 'anywhere' }}>{`${extraIdTitle}  ${trade.extraId}`}</span> : null}
              <span style={{ fontSize: '12px' }}>{createdText(trade.createdAt)}</span>
              <span style={{ height: '35px' }} />
              <span style={{ fontSize: '24px', fontWeight: 700 }}>{`${trade.from.title} → ${trade.to.title}`}</span>
            </button>
          </div>
        )}
        {!!trade.toAddressExtraId && trade.to && <DetailRow label={memoLabelType(trade.to) === 'destinationTag' ? t('destination_tag') : t('memo')} value={trade.toAddressExtraId} />}
        <DetailRow label={t('trade_details_provider')} value={desc?.title ?? ''} id="trade_provider" />
        {track && <DetailRow label={t('track')} value={track} id="trade_track" onLaunch={() => window.open(track, '_blank', 'noopener,noreferrer')} />}
        {trade.isRefund && <DetailRow label="Refund" value={trade.refundAddress ?? ''} />}
        {trade.providerRaw === PROVIDERS.trocador.raw && (
          <>
            <DetailRow label={`${trade.providerName ?? ''} ${t('id').toUpperCase()}`} value={trade.providerId ?? ''} />
            {!!trade.password && <DetailRow label={`${trade.providerName ?? ''} ${t('password')}`} value={trade.password} />}
          </>
        )}
        {trade.providerRaw === PROVIDERS.swapsXyz.raw && !!trade.txId && <DetailRow label="Transaction ID" value={trade.txId} />}
      </div>
    </Page>
  );
}

/** HistoryTradeTile: the state and the provider's logo, both amounts, the two coins */
export function TradeTile({ trade, first, last, hidden }: { trade: Trade; first?: boolean; last?: boolean; hidden?: boolean }) {
  const desc = providerByRaw(trade.providerRaw);
  const from = trade.from;
  const to = trade.to;
  const fromBadge = from ? badgeFor(from) : null;
  const toBadge = to ? badgeFor(to) : null;
  return (
    <button
      type="button"
      class="history-tile"
      id={`trade_tile_${trade.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`}
      onClick={() => nav.push(Routes.tradeDetails, { id: trade.id })}
      style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', border: 0, background: 'var(--surface-container)', padding: '12px 16px 12px 12px', cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start', borderTopLeftRadius: first ? '22px' : 0, borderTopRightRadius: first ? '22px' : 0, borderBottomLeftRadius: last ? '22px' : 0, borderBottomRightRadius: last ? '22px' : 0, position: 'relative' }}
    >
      {!first && <span style={{ position: 'absolute', top: 0, left: '56px', right: '16px', height: '1px', background: 'color-mix(in srgb, var(--outline-variant) 69%, transparent)' }} />}
      <span style={{ position: 'relative', width: '36px', height: '36px', flex: 'none' }}>
        {from && to && (
          <>
            <Img src={from.iconPath ?? undefined} size={22} round />
            <span style={{ position: 'absolute', top: '11px', left: '11px', borderRadius: '50%', border: '2px solid var(--surface-container)', display: 'flex' }}><Img src={to.iconPath ?? undefined} size={22} round /></span>
          </>
        )}
      </span>
      <span class="grow col" style={{ gap: '2px', minWidth: 0 }}>
        <span class="rowx" style={{ gap: '4px' }}>
          <span>{stateOf(trade.stateRaw).title}</span>
          {desc?.image && <Img src={desc.image} size={14} />}
        </span>
        <span class="muted">{historyDate(trade.createdAt ?? Date.now())}</span>
      </span>
      <span class="col" style={{ alignItems: 'flex-end', gap: '2px' }}>
        <span class="rowx" style={{ gap: '4px' }}>
          <span>+</span>
          <span style={{ fontWeight: 500 }}>{hidden ? '---' : withMaxDecimals(formatTradeAmount(trade.receiveAmount), 8)}</span>
          {to && <span>{to.title}</span>}
          {toBadge && <Icon src={toBadge} size={12} color="var(--on-surface)" />}
        </span>
        <span class="rowx muted" style={{ gap: '4px' }}>
          <span>-</span>
          <span style={{ fontWeight: 500 }}>{hidden ? '---' : withMaxDecimals(formatTradeAmount(trade.amount), 8)}</span>
          {from && <span>{from.title}</span>}
          {fromBadge && <Icon src={fromBadge} size={12} color="var(--on-surface-variant)" />}
        </span>
      </span>
    </button>
  );
}

registerRoute(Routes.tradeDetails, TradeDetailsPage);
