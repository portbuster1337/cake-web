// The new-UI currency picker as the swap uses it
// (lib/new-ui/widgets/currency_picker/*): the single-network layout (the
// wallet's coin and tokens with balances, "Send another asset") and the
// multi-network layout (chain chips, recents, stablecoin pills, sections,
// "All assets"), with the search field at the bottom.

import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../../core/i18n.ts';
import { Icon, Img, MIcon, ModernButton, TopBar } from '../../components/core.tsx';
import { showSheet } from '../../components/overlays.tsx';
import { ALL_CURRENCIES, AVAILABLE_WALLET_TYPES, WALLET_CURRENCY, WALLET_TYPE_NAME, currency as builtinCurrency, type WalletType } from '../../../coins/types.ts';
import { builtinOf, eqCurrency, walletTypeOf, type SwapCurrency } from '../../../exchange/currency.ts';
import { trades } from '../../../exchange/trades.ts';

export interface PickerBalance {
  amount: string;
  fiat?: string;
  fiatValue?: number;
}

export interface PickerArgs {
  items: SwapCurrency[];
  selected?: SwapCurrency;
  /** currency id → balance (single-network layout) */
  balanceByAsset?: Map<string, PickerBalance>;
  filterByNetwork?: WalletType;
  useSingleNetworkLayout?: boolean;
  walletName?: string;
  /** RecentsSource.trades */
  recents?: boolean;
  showStablesHeader?: boolean;
  /** "Send another asset": the full list */
  otherAssets?: PickerArgs;
}

export interface PickResult {
  currency: SwapCurrency;
  /** picked from the "Send another asset" list */
  fromOtherAssets: boolean;
}

const NATIVES = new Set(AVAILABLE_WALLET_TYPES.map((w) => WALLET_CURRENCY[w]));
/** _stablecoinSymbols: the titles of CryptoCurrency.all's stablecoins */
const STABLE_SYMBOLS = new Set(ALL_CURRENCIES.filter((c) => c.groups.includes('stablecoin')).map((c) => c.title.toUpperCase()));
const stableSymbols = () => STABLE_SYMBOLS;

const isNative = (c: SwapCurrency) => !c.address && NATIVES.has(c.id);
const isTrustedStablecoin = (c: SwapCurrency) => c.groups.includes('stablecoin') || stableSymbols().has(c.title.toUpperCase());
const hasBuiltInStablecoinSymbol = (c: SwapCurrency) => stableSymbols().has(c.title.toUpperCase());
const isL2NativeEth = (c: SwapCurrency) => !c.address && (c.id === 'arbEth' || c.id === 'baseEth' || c.id === 'robEth');

/** chainNameForCurrency */
export function chainNameFor(c: SwapCurrency): string {
  if (builtinOf(c)?.key === 'btcln') return 'Lightning';
  const wt = walletTypeOf(c);
  return wt ? WALLET_TYPE_NAME[wt] : c.tag ?? '';
}

/** assetNameForCurrency */
export function assetNameFor(c: SwapCurrency): string {
  return builtinOf(c)?.key === 'btcln' ? 'Bitcoin' : c.fullName ?? c.title;
}

function nativeChainIcon(wt: WalletType): string | null {
  return builtinCurrency(WALLET_CURRENCY[wt]).chainIconPath;
}

function shortChainLabel(c: SwapCurrency): string {
  const wt = walletTypeOf(c);
  if (wt === 'bsc') return 'BSC';
  if (wt === 'robinhood') return 'ROB';
  return chainNameFor(c);
}

function chainPillFor(c: SwapCurrency): string | null {
  if (builtinOf(c)?.key === 'btcln' || isL2NativeEth(c)) return shortChainLabel(c);
  if (isNative(c) || !walletTypeOf(c)) return null;
  return shortChainLabel(c);
}

function chainBadgeFor(c: SwapCurrency): string | null {
  if (isL2NativeEth(c)) return c.chainIconPath;
  if (isNative(c)) return null;
  const wt = walletTypeOf(c);
  if (!wt) return null;
  return c.chainIconPath ?? nativeChainIcon(wt);
}

/** currencyMatchesQuery */
function matches(c: SwapCurrency, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return c.title.toLowerCase().includes(s) || c.name.toLowerCase().includes(s) || (c.fullName ?? '').toLowerCase().includes(s) || (c.tag ?? '').toLowerCase().includes(s) || chainNameFor(c).toLowerCase().includes(s);
}

const byName = (a: SwapCurrency, b: SwapCurrency) => (a.fullName ?? a.title).toLowerCase().localeCompare((b.fullName ?? b.title).toLowerCase());

/** PickerRecentsLoader: up to 6 currencies of executed trades, newest first */
function recentCurrencies(visible: SwapCurrency[]): SwapCurrency[] {
  const done = new Set(['complete', 'completed', 'finished', 'success', 'settled', 'traded']);
  const list = trades.value.filter((x) => done.has(x.stateRaw)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const out: SwapCurrency[] = [];
  for (const tr of list) {
    for (const c of [tr.from, tr.to]) {
      if (!c || out.length >= 6) continue;
      const v = visible.find((x) => eqCurrency(x, c));
      if (v && !out.some((x) => eqCurrency(x, v))) out.push(v);
    }
  }
  return out;
}

// ------------------------------------------------------------------ rows --

function IconWithBadge({ c, badge }: { c: SwapCurrency; badge: string | null }) {
  return (
    <span style={{ position: 'relative', width: '28px', height: '28px', flex: 'none' }}>
      {c.iconPath ? <Img src={c.iconPath} size={28} round /> : <span style={{ display: 'flex', width: '28px', height: '28px', borderRadius: '50%', background: 'var(--surface-container-high)', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 600 }}>{c.title.slice(0, 3)}</span>}
      {badge && (
        <span style={{ position: 'absolute', right: '-2px', bottom: '-2px', width: '12px', height: '12px', padding: '3px', boxSizing: 'border-box', borderRadius: '4px', background: 'var(--on-surface)', display: 'flex' }}>
          <Icon src={badge} size={6} color="var(--surface)" />
        </span>
      )}
    </span>
  );
}

function PickerRow({ c, selected, pill, badge, subtitle, trailing, onClick, first }: { c: SwapCurrency; selected: boolean; pill: string | null; badge: string | null; subtitle?: string; trailing: ComponentChildren; onClick: () => void; first: boolean }) {
  return (
    <>
      {!first && <div style={{ height: '1px', margin: '0 12px', background: 'var(--surface-container-high)' }} />}
      <button type="button" class="rowx" onClick={onClick} id={`swap_currency_${c.id.replace(/[^a-zA-Z0-9]/g, '_')}`} aria-pressed={selected} style={{ width: '100%', height: subtitle ? '56px' : '48px', padding: '0 12px', gap: '12px', border: 0, background: 'none', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
        <IconWithBadge c={c} badge={badge} />
        <span class="col grow" style={{ minWidth: 0, gap: '4px' }}>
          <span class="rowx" style={{ gap: '6px', minWidth: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px', letterSpacing: '-0.07px' }}>{assetNameFor(c)}</span>
            {pill && <span style={{ flex: 'none', padding: '2px 8px', borderRadius: '20px', background: 'var(--surface-container-high)', color: 'var(--primary)', fontSize: '12px', fontWeight: 500 }}>{pill}</span>}
          </span>
          {subtitle && <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{subtitle}</span>}
        </span>
        {trailing}
        <span style={{ width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Icon src="arrow_right.svg" w={7} h={12} color={selected ? 'var(--primary)' : 'var(--on-surface-variant)'} />
        </span>
      </button>
    </>
  );
}

function ListBox({ children }: { children: ComponentChildren }) {
  return <div style={{ background: 'var(--surface-container)', borderRadius: '18px', overflow: 'hidden' }}>{children}</div>;
}

function SectionHeader({ title }: { title: string }) {
  return <div style={{ paddingBottom: '12px', color: 'var(--on-surface-variant)', fontSize: '14px' }}>{title}</div>;
}

const symbolTrailing = (c: SwapCurrency) => <span style={{ fontSize: '14px', color: 'var(--on-surface-variant)', letterSpacing: '-0.07px' }}>{c.title.length > 8 ? c.title.slice(0, 8) : c.title}</span>;

/** CurrencyPickerFooter: the search field over a fade, with an optional action above it */
function Footer({ q, setQ, action }: { q: string; setQ: (v: string) => void; action?: ComponentChildren }) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: '32px', background: 'linear-gradient(to bottom, color-mix(in srgb, var(--surface) 0%, transparent), var(--surface) 40%)' }}>
      {action && <div style={{ padding: '0 16px 12px' }}>{action}</div>}
      <div style={{ padding: '8px 16px 16px' }}>
        <div class="rowx" style={{ height: '44px', paddingRight: '16px', borderRadius: '28px', background: 'var(--surface-container)', boxSizing: 'border-box' }}>
          <span style={{ width: '44px', display: 'flex', justifyContent: 'center' }}><MIcon name="search" size={20} color="var(--primary)" /></span>
          <input value={q} placeholder={t('search')} onInput={(e) => setQ((e.target as HTMLInputElement).value)} id="swap_currency_search" style={{ flex: 1, border: 0, background: 'none', outline: 'none', color: 'var(--on-surface)', fontSize: '12.8px' }} />
          {q && <button type="button" aria-label={t('clear')} onClick={() => setQ('')} style={{ border: 0, background: 'none', padding: '4px', cursor: 'pointer', display: 'flex' }}><MIcon name="close" size={16} color="var(--on-surface-variant)" /></button>}
        </div>
      </div>
    </div>
  );
}

const FOOTER_SPACE = '96px';
const FOOTER_SPACE_ACTION = '160px';

// ---------------------------------------------------------- single network --

function SingleNetwork({ args, pick, onOther }: { args: PickerArgs; pick: (c: SwapCurrency) => void; onOther?: () => void }) {
  const [q, setQ] = useState('');
  const network = args.filterByNetwork!;
  const native = useMemo(() => args.items.find((c) => !c.address && c.id === WALLET_CURRENCY[network]) ?? null, [args.items]);
  const query = q.trim();
  const fiat = (c: SwapCurrency) => args.balanceByAsset?.get(c.id)?.fiatValue ?? 0;
  const tokens = args.items.filter((c) => !(native && eqCurrency(c, native)) && walletTypeOf(c) === network && matches(c, query)).map((c, i) => [c, i] as const).sort((a, b) => fiat(b[0]) - fiat(a[0]) || a[1] - b[1]).map(([c]) => c);
  const nativeMatches = !!native && matches(native, query);
  const hasTokens = ['ethereum', 'polygon', 'solana', 'tron', 'zano', 'base', 'arbitrum', 'bsc', 'robinhood'].includes(network);
  const standard = network === 'bsc' ? 'BEP-20' : network === 'solana' ? 'SPL' : network === 'tron' ? 'TRC-20' : 'ERC-20';
  const row = (c: SwapCurrency, first: boolean) => {
    const chain = chainNameFor(c);
    const bal = args.balanceByAsset?.get(c.id);
    return (
      <PickerRow
        c={c}
        first={first}
        selected={eqCurrency(args.selected, c)}
        subtitle={c.title.length > 8 ? c.title.slice(0, 8) : c.title}
        pill={chain === WALLET_TYPE_NAME[network] ? null : chain}
        badge={c.chainIconPath ?? nativeChainIcon(network)}
        trailing={
          <span class="col" style={{ alignItems: 'flex-end', gap: '4px' }}>
            <span style={{ fontSize: '12px' }}>{bal?.amount ?? '—'}</span>
            {bal?.fiat && <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{bal.fiat}</span>}
          </span>
        }
        onClick={() => pick(c)}
      />
    );
  };
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: `8px 16px ${onOther ? FOOTER_SPACE_ACTION : FOOTER_SPACE}` }}>
        {nativeMatches || tokens.length ? (
          <>
            {args.walletName && (
              <div class="rowx" style={{ gap: '8px', marginBottom: '24px', fontSize: '12px' }}>
                <span>{t('from')}</span>
                <Icon src="wallet_filled.svg" size={16} color="var(--on-surface-variant)" />
                <span style={{ fontWeight: 500, color: 'var(--on-surface-variant)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{args.walletName}</span>
              </div>
            )}
            {hasTokens ? (
              <>
                {nativeMatches && (
                  <>
                    <SectionHeader title={t('picker_section_gas_token')} />
                    <ListBox>{row(native!, true)}</ListBox>
                    <div style={{ height: '24px' }} />
                  </>
                )}
                {tokens.length > 0 && (
                  <>
                    <SectionHeader title={t('picker_section_tokens_standard', { standard })} />
                    <ListBox>{tokens.map((c, i) => row(c, i === 0))}</ListBox>
                  </>
                )}
              </>
            ) : (
              <ListBox>{[...(nativeMatches ? [native!] : []), ...tokens].map((c, i) => row(c, i === 0))}</ListBox>
            )}
          </>
        ) : (
          <div class="center muted" style={{ padding: '24px' }}>{t('picker_no_matches')}</div>
        )}
      </div>
      <Footer
        q={q}
        setQ={setQ}
        action={
          onOther && (
            <button type="button" id="swap_send_another_asset" onClick={onOther} class="rowx" style={{ width: '100%', height: '52px', justifyContent: 'center', gap: '8px', borderRadius: '16px', border: 0, background: 'var(--surface-container)', color: 'var(--primary)', fontWeight: 500, fontSize: '15px', cursor: 'pointer' }}>
              {t('send_another_asset')}
            </button>
          )
        }
      />
    </div>
  );
}

// ----------------------------------------------------------- multi network --

function MultiNetwork({ args, pick, pickVariant }: { args: PickerArgs; pick: (c: SwapCurrency) => void; pickVariant: (title: string, variants: SwapCurrency[]) => void }) {
  const [q, setQ] = useState('');
  const [network, setNetwork] = useState<WalletType | null>(null);
  const [moreOpen, setMoreOpen] = useState(() => {
    const list = args.items.filter((c) => !isNative(c) && !walletTypeOf(c) && c.tag === null && !c.groups.includes('stablecoin') && !c.groups.includes('tokenizedStock')).sort(byName);
    return !!args.selected && list.findIndex((c) => eqCurrency(c, args.selected)) >= 3;
  });
  const [stocksOpen, setStocksOpen] = useState(() => {
    const list = args.items.filter((c) => c.groups.includes('tokenizedStock'));
    return !!args.selected && list.findIndex((c) => eqCurrency(c, args.selected)) >= 3;
  });
  const networks = useMemo(() => {
    const counts = new Map<WalletType, number>();
    for (const c of args.items) {
      const wt = walletTypeOf(c);
      if (wt) counts.set(wt, (counts.get(wt) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n >= 2).map(([w]) => w);
  }, [args.items]);
  const recents = useMemo(() => (args.recents ? recentCurrencies(args.items) : []), [args.items]);
  const query = q.trim();
  const items = args.items.filter((c) => (c.tag === null || !!walletTypeOf(c)) && matches(c, query) && (network === null || walletTypeOf(c) === network));
  const sel = args.selected;
  const symbolRow = (c: SwapCurrency, i: number, selected: boolean, withChain = true) => <PickerRow c={c} first={i === 0} selected={selected} pill={withChain ? chainPillFor(c) : null} badge={withChain ? chainBadgeFor(c) : null} trailing={symbolTrailing(c)} onClick={() => pick(c)} />;
  const onStable = (tapped: SwapCurrency) => {
    let variants = args.items.filter((c) => isTrustedStablecoin(c) && c.title.toUpperCase() === tapped.title.toUpperCase() && !!walletTypeOf(c));
    if (network !== null) {
      const f = variants.filter((c) => walletTypeOf(c) === network);
      if (f.length) variants = f;
    }
    if (variants.length <= 1) pick(variants[0] ?? tapped);
    else pickVariant(tapped.title, variants);
  };
  let body: ComponentChildren;
  if (!items.length) body = <div class="center muted" style={{ padding: '24px' }}>{t('picker_no_matches')}</div>;
  else if (query) body = <ListBox>{items.map((c, i) => symbolRow(c, i, eqCurrency(sel, c)))}</ListBox>;
  else {
    const visibleRecents = recents.filter((r) => items.some((c) => eqCurrency(c, r)));
    const single = new Set(items.map((c) => walletTypeOf(c))).size === 1;
    const seen = new Set<string>();
    const stables = items.filter((c) => isTrustedStablecoin(c) && (single || hasBuiltInStablecoinSymbol(c)) && !seen.has(c.title.toUpperCase()) && (seen.add(c.title.toUpperCase()), true));
    const cryptos = items.filter(isNative);
    const more = items.filter((c) => !isNative(c) && !walletTypeOf(c) && c.tag === null && !c.groups.includes('stablecoin') && !c.groups.includes('tokenizedStock')).sort(byName);
    const stocks = items.filter((c) => c.groups.includes('tokenizedStock'));
    const all = [...items].sort(byName);
    // _selectedSection: the selection is highlighted in one section only
    const section = !sel ? null : visibleRecents.some((c) => eqCurrency(c, sel)) ? 'recents' : stables.some((c) => c.title.toUpperCase() === sel.title.toUpperCase()) ? 'stables' : cryptos.some((c) => eqCurrency(c, sel)) ? 'cryptos' : more.some((c) => eqCurrency(c, sel)) ? 'more' : stocks.some((c) => eqCurrency(c, sel)) ? 'stocks' : 'all';
    const is = (s: string, c: SwapCurrency) => section === s && eqCurrency(sel, c);
    const seeAll = (open: boolean, toggle: () => void) => (
      <>
        <div style={{ height: '1px', margin: '0 12px', background: 'var(--surface-container-high)' }} />
        <button type="button" onClick={toggle} style={{ width: '100%', padding: '14px 12px', border: 0, background: 'none', textAlign: 'start', color: 'var(--primary)', fontWeight: 500, fontSize: '14px', cursor: 'pointer' }}>{open ? t('picker_show_less') : t('picker_see_all')}</button>
      </>
    );
    body = (
      <>
        {visibleRecents.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <SectionHeader title={t('picker_section_recents')} />
            <div class="rowx" style={{ gap: '4px', overflowX: 'auto', scrollbarWidth: 'none' }}>
              {visibleRecents.map((c) => (
                <button type="button" onClick={() => pick(c)} class="rowx" style={{ flex: 'none', height: '36px', padding: '0 10px 0 6px', gap: '8px', borderRadius: '80px', background: 'var(--surface-container)', border: is('recents', c) ? '1.5px solid var(--primary)' : '1.5px solid transparent', color: 'var(--on-surface)', cursor: 'pointer', fontSize: '12px', fontWeight: 500 }}>
                  <Img src={c.iconPath ?? undefined} size={24} round />
                  {c.title}
                </button>
              ))}
            </div>
          </div>
        )}
        {stables.length > 0 && args.showStablesHeader !== false && (
          <div style={{ marginBottom: '20px' }}>
            <SectionHeader title={t('picker_section_stablecoins')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {stables.map((c) => (
                <button type="button" onClick={() => onStable(c)} id={`swap_stable_${c.title}`} class="rowx" style={{ height: '36px', padding: '0 8px 0 6px', gap: '8px', borderRadius: '20px', background: 'var(--surface-container)', border: is('stables', c) || (section === 'stables' && sel?.title.toUpperCase() === c.title.toUpperCase()) ? '1.5px solid var(--primary)' : '1.5px solid transparent', color: 'var(--on-surface)', cursor: 'pointer', fontSize: '12px', fontWeight: 500, minWidth: 0 }}>
                  <Img src={c.iconPath ?? undefined} size={24} round />
                  <span class="grow" style={{ textAlign: 'start', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                  <Icon src="arrow_right.svg" w={5} h={9} color="var(--on-surface-variant)" />
                </button>
              ))}
            </div>
          </div>
        )}
        {cryptos.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <SectionHeader title={t('picker_section_cryptocurrencies')} />
            <ListBox>{cryptos.map((c, i) => symbolRow(c, i, is('cryptos', c)))}</ListBox>
          </div>
        )}
        {more.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <SectionHeader title={t('picker_section_more_cryptocurrencies')} />
            <ListBox>
              {(moreOpen ? more : more.slice(0, 3)).map((c, i) => symbolRow(c, i, is('more', c), false))}
              {more.length > 3 && seeAll(moreOpen, () => setMoreOpen(!moreOpen))}
            </ListBox>
          </div>
        )}
        {stocks.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <SectionHeader title={t('picker_section_tokenized_stocks')} />
            <ListBox>
              {(stocksOpen ? stocks : stocks.slice(0, 3)).map((c, i) => symbolRow(c, i, is('stocks', c)))}
              {stocks.length > 3 && seeAll(stocksOpen, () => setStocksOpen(!stocksOpen))}
            </ListBox>
          </div>
        )}
        <div style={{ marginBottom: '20px' }}>
          <SectionHeader title={t('picker_section_all_assets')} />
          <ListBox>{all.map((c, i) => symbolRow(c, i, is('all', c)))}</ListBox>
        </div>
      </>
    );
  }
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {networks.length > 1 && (
        <div class="rowx" style={{ height: '48px', flex: 'none', padding: '4px 16px 8px', gap: '4px', overflowX: 'auto', scrollbarWidth: 'none', boxSizing: 'border-box' }}>
          {[null, ...networks].map((n) => {
            const on = n === network;
            return (
              <button type="button" onClick={() => setNetwork(n)} id={`swap_chain_${n ?? 'all'}`} style={{ flex: 'none', height: '36px', padding: `0 ${on ? 12 : 10}px`, borderRadius: '80px', border: 0, background: on ? 'var(--primary)' : 'var(--surface-container)', color: on ? 'var(--on-primary)' : 'var(--primary)', fontWeight: 500, fontSize: on ? '14px' : '12px', cursor: 'pointer' }}>
                {n === null ? t('picker_chip_all') : WALLET_TYPE_NAME[n]}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: `8px 16px ${FOOTER_SPACE}` }}>{body}</div>
      <Footer q={q} setQ={setQ} />
    </div>
  );
}

/** SelectNetworkPage: one stablecoin on several networks */
function SelectNetwork({ title, variants, pick, back }: { title: string; variants: SwapCurrency[]; pick: (c: SwapCurrency) => void; back: () => void }) {
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }} id="swap_select_network">
      <TopBar title={t('select_network')} onBack={back} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 24px' }}>
        <SectionHeader title={title} />
        <ListBox>{variants.map((c, i) => <PickerRow c={c} first={i === 0} selected={false} pill={chainPillFor(c)} badge={chainBadgeFor(c)} trailing={<span style={{ fontSize: '14px', color: 'var(--on-surface-variant)' }}>{chainNameFor(c)}</span>} onClick={() => pick(c)} />)}</ListBox>
      </div>
    </div>
  );
}

/** CurrencyPickerSheet.show */
export function pickSwapCurrency(args: PickerArgs): Promise<PickResult | undefined> {
  return showSheet<PickResult>((close) => <PickerSheet args={args} close={close} />, { full: true, dismissible: false });
}

function PickerSheet({ args, close }: { args: PickerArgs; close: (r?: PickResult) => void }) {
  const [page, setPage] = useState<{ kind: 'main' } | { kind: 'other' } | { kind: 'network'; title: string; variants: SwapCurrency[]; from: 'main' | 'other' }>({ kind: 'main' });
  const fromOther = page.kind === 'other' || (page.kind === 'network' && page.from === 'other');
  const pick = (c: SwapCurrency) => close({ currency: c, fromOtherAssets: fromOther });
  const current = page.kind === 'other' ? args.otherAssets! : args;
  if (page.kind === 'network') return <SelectNetwork title={page.title} variants={page.variants} pick={pick} back={() => setPage({ kind: page.from })} />;
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)', borderRadius: '24px 24px 0 0' }} id="swap_currency_picker">
      <TopBar
        title={t('select_asset')}
        leading={page.kind === 'other' ? <ModernButton icon="back" size={36} iconSize={18} color="var(--on-surface-variant)" label={t('seed_alert_back')} onClick={() => setPage({ kind: 'main' })} /> : <ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} onClick={() => close()} />}
      />
      {current.useSingleNetworkLayout && current.filterByNetwork ? (
        <SingleNetwork args={current} pick={pick} onOther={page.kind === 'main' && args.otherAssets ? () => setPage({ kind: 'other' }) : undefined} />
      ) : (
        <MultiNetwork args={current} pick={pick} pickVariant={(title, variants) => setPage({ kind: 'network', title, variants, from: page.kind === 'other' ? 'other' : 'main' })} />
      )}
    </div>
  );
}
