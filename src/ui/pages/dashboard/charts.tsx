// Charts tab (lib/new-ui/pages/charts_page.dart, lib/new-ui/widgets/charts_page/*, the ChartsBloc in
// lib/new-ui/viewmodels/charts/*): the pinned asset's chart, the followed assets (long press: favorite,
// remove), sorting, the chart modal. Opening the tab starts over as Cake's Init does: the 30-day range,
// sorted by market cap, prices loaded again.

import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Icon, Img, ModernButton, Spinner } from '../../components/core.tsx';
import { showSheet } from '../../components/overlays.tsx';
import { showLongPressMenu, useLongPress } from '../../components/longPress.tsx';
import { pickSwapCurrency } from '../swap/picker.tsx';
import { builtin, builtinOf } from '../../../exchange/currency.ts';
import { settings } from '../../../app/settings.ts';
import { currentWallet } from '../../../app/app.ts';
import { fetchHistory } from '../../../app/prices.ts';
import { ALL_CURRENCIES, currency, currencyFromString, type Currency } from '../../../coins/types.ts';
import { vault } from '../../../core/vault.ts';
import { withLocalSeparator } from '../../../core/amount.ts';
import { nav } from '../../nav.ts';
import { Routes } from '../../routes.ts';
import {
  alignedPoints,
  apiString,
  changeData,
  CHART_RANGES,
  DEFAULT_ASSETS,
  DEFAULT_RANGE,
  gridPrice,
  initAssets,
  insertAsset,
  lastPrice,
  priceMoney,
  rangeOf,
  rangeStart,
  removeAsset,
  scrubPrice,
  scrubTime,
  SORT_CRITERIA,
  SORT_ICONS,
  sortAssets,
  toStringWithPrecision,
  type ChangeData,
  type ChartRangeId,
  type ChartsAssetRow,
  type SortCriterion,
} from '../../../app/chartsModel.ts';

// ------------------------------------------------------------------ the bloc --

interface ChartsState {
  /** ChartsDisabled / ChartsInitial / ChartsLoading / ChartsLoaded */
  phase: 'disabled' | 'initial' | 'loading' | 'loaded';
  /** the session's assets (currency keys): the table's, then those added */
  assets: string[];
  pinned: string;
  range: ChartRangeId;
  sort: SortCriterion;
  /** loaded: each asset's prices over the range, and the fiat currency they are in */
  prices: Record<string, [number, number][]>;
  fiat: string;
}

const STORE = 'charts:assets';
const charts = signal<ChartsState>({ phase: 'initial', assets: [], pinned: 'btc', range: DEFAULT_RANGE, sort: 'marketcap', prices: {}, fiat: '' });
let rows: ChartsAssetRow[] | null = null;
let generation = 0;

/** the ChartsAssets table (the earlier {keys, pinned} record read as rows) */
async function readRows(): Promise<ChartsAssetRow[]> {
  const v = await vault.get<unknown>(STORE).catch(() => undefined);
  if (Array.isArray(v)) return v as ChartsAssetRow[];
  const old = v as { keys?: string[]; pinned?: string } | undefined;
  if (old && Array.isArray(old.keys)) {
    let r: ChartsAssetRow[] = [];
    for (const k of old.keys) {
      try {
        r = insertAsset(r, apiString(currency(k).title), k === old.pinned);
      } catch { /* an unknown key */ }
    }
    return r;
  }
  return DEFAULT_ASSETS;
}

function writeRows(r: ChartsAssetRow[]) {
  rows = r;
  void vault.put(STORE, r).catch(() => {});
}

/** currencyFromApiString: "crypto.BTC" → CryptoCurrency.fromString("BTC") */
const keyOfApi = (api: string) => currencyFromString(api.slice(api.indexOf('.') + 1))?.key;
const apiOf = (key: string) => apiString(currency(key).title);
/** the decimals of the currency Cake's prices are parsed in (the asset's api currency) */
const priceDecimals = (c: Currency) => (currencyFromString(c.title) ?? c).decimals;

/** Init: on each opening of the tab */
export async function initCharts(): Promise<void> {
  generation++;
  if (settings.peek().fiatApiMode === 'disabled') {
    charts.value = { ...charts.peek(), phase: 'disabled' };
    return;
  }
  if (charts.peek().phase !== 'initial') charts.value = { ...charts.peek(), phase: 'initial' };
  const stored = await readRows();
  const init = initAssets(stored);
  if (init.rows !== stored) writeRows(init.rows);
  else rows = stored;
  const assets = init.assets.map(keyOfApi).filter((k): k is string => !!k);
  if (!assets.length) assets.push('btc');
  const pinned = keyOfApi(init.pinned) ?? assets[0];
  charts.value = { phase: 'loading', assets, pinned, range: DEFAULT_RANGE, sort: 'marketcap', prices: {}, fiat: '' };
  await load();
}

/** PageLoadStarted (a later one replaces it): each asset's prices over the range */
async function load(): Promise<void> {
  const mine = ++generation;
  const s = charts.peek();
  const fiat = settings.peek().fiatCurrency;
  const start = rangeStart(s.range, Math.floor(Date.now() / 1000));
  const precision = rangeOf(s.range).precision;
  const unique = [...new Set(s.assets)];
  const entries = await Promise.all(
    unique.map(async (k) => {
      const c = currency(k);
      const api = currencyFromString(c.title) ?? c;
      const points = await fetchHistory(`crypto.${api.title}`, start, precision, fiat).catch(() => [] as [number, number][]);
      return [k, alignedPoints(points, s.range)] as const;
    }),
  );
  if (mine !== generation) return;
  charts.value = { ...charts.peek(), phase: 'loaded', prices: Object.fromEntries(entries), fiat };
}

const reload = (patch: Partial<ChartsState>) => {
  charts.value = { ...charts.peek(), ...patch, phase: 'loading' };
  void load();
};

/** RangeChanged (the chart modal's too: the range is the page's) */
const hasData = () => charts.peek().phase === 'loading' || charts.peek().phase === 'loaded';

function changeRange(range: ChartRangeId) {
  if (hasData()) reload({ range });
}

/** PageRefreshed */
function refreshCharts() {
  if (hasData()) reload({});
}

const currentRows = async () => rows ?? (await readRows());

/** CurrencyAdded */
async function addAsset(key: string) {
  writeRows(insertAsset(await currentRows(), apiOf(key), false));
  reload({ assets: [...charts.peek().assets, key] });
}

/** CurrencyRemoved: a removed pinned asset gives way to the first */
async function removeFollowed(key: string) {
  const s = charts.peek();
  const i = s.assets.indexOf(key);
  if (i < 0) return;
  const assets = [...s.assets.slice(0, i), ...s.assets.slice(i + 1)];
  if (!assets.length) return;
  let r = await currentRows();
  let pinned = s.pinned;
  if (s.pinned === key) {
    pinned = assets[0];
    r = insertAsset(insertAsset(r, apiOf(s.pinned), false), apiOf(pinned), true);
  }
  writeRows(removeAsset(r, apiOf(key)));
  reload({ assets, pinned });
}

/** CurrencyPinned */
async function pinAsset(key: string) {
  const s = charts.peek();
  if (s.pinned === key) return;
  writeRows(insertAsset(insertAsset(await currentRows(), apiOf(s.pinned), false), apiOf(key), true));
  reload({ pinned: key });
}

/** ChartsLoaded.currencies: the loaded assets in the sort's order (the loading list as it is) */
function listed(s: ChartsState): string[] {
  if (s.phase !== 'loaded') return s.assets;
  const unique = Object.keys(s.prices).map((k) => currency(k));
  return sortAssets(unique, s.sort, (c) => changeData(s.prices[c.key], priceDecimals(c))).map((c) => c.key);
}

/** fiatTicker: the first asset's prices name it (none while loading) */
const fiatTicker = (s: ChartsState) => (s.phase === 'loaded' && s.prices[Object.keys(s.prices)[0]]?.length ? s.fiat : '');

// ------------------------------------------------------------------ widgets --

/** PriceChangeDirection's colors */
function dirColor(up: boolean): string {
  const dark = document.documentElement.dataset.theme !== 'light';
  return up ? (dark ? '#6FC84E' : '#00C317') : dark ? '#EA696F' : '#F9434C';
}

/** FittedBox(fit: scaleDown): shrunk to fit its box, never enlarged */
function FitText({ children, align, style }: { children: ComponentChildren; align: 'left' | 'right'; style?: Record<string, string> }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    i.style.transform = '';
    const scale = i.scrollWidth > o.clientWidth && o.clientWidth > 0 ? o.clientWidth / i.scrollWidth : 1;
    if (scale < 1) i.style.transform = `scale(${scale})`;
  });
  return (
    <span ref={outer} style={{ display: 'flex', justifyContent: align === 'right' ? 'flex-end' : 'flex-start', minWidth: 0, flex: 1, overflow: 'hidden', ...style }}>
      <span ref={inner} style={{ display: 'inline-flex', whiteSpace: 'nowrap', transformOrigin: `${align} center` }}>{children}</span>
    </span>
  );
}

function ChangePill({ change }: { change: ChangeData }) {
  const c = dirColor(change.up);
  return <span style={{ background: `color-mix(in srgb, ${c} 20.4%, transparent)`, color: c, borderRadius: '999px', padding: '2.5px 8px 2.5px 4px', whiteSpace: 'nowrap' }}>{`${change.up ? '+' : '-'} ${change.percentage}%`}</span>;
}

/** ChangeDisplay: "+USD 12.3" and the pill */
function ChangeDisplay({ change, ticker }: { change: ChangeData; ticker: string }) {
  const amount = withLocalSeparator(toStringWithPrecision(change.amount, change.amountDecimals, { fractionalDigits: 2, meaningfulDecimals: 2 }), settings.value.languageCode);
  return (
    <span class="rowx" style={{ gap: '10px' }} id="chart_change">
      <span style={{ fontSize: '16px', color: dirColor(change.up) }}>{`${change.up ? '+' : '-'}${ticker} ${amount}`}</span>
      <ChangePill change={change} />
    </span>
  );
}

let chartIds = 0;

/** PriceChart (fl_chart): the line in a gradient of its direction's color; the touched point's dashed line and dot */
function LineChart({ pts, height, up, onScrub }: { pts: [number, number][]; height: number; up: boolean; onScrub: (p: [number, number] | null) => void }) {
  const gid = useMemo(() => `chart_line_${++chartIds}`, []);
  const [hover, setHover] = useState<number | null>(null);
  const w = 400;
  if (pts.length < 2) return <div style={{ height: `${height}px` }} />;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const x0 = pts[0][0];
  const x1 = pts[pts.length - 1][0];
  const X = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * w;
  const Y = (y: number) => height - 1 - ((y - min) / Math.max(1e-12, max - min)) * (height - 2);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  const color = dirColor(up);
  const clear = () => {
    setHover(null);
    onScrub(null);
  };
  const move = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * w;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(X(pts[i][0]) - fx) < Math.abs(X(pts[best][0]) - fx)) best = i;
    setHover(best);
    onScrub(pts[best]);
  };
  // the dot: the gradient's color where it is (color@25 → color), its stroke 10 % darker
  const frac = hover === null ? 0 : X(pts[hover][0]) / w;
  const alpha = 25 / 255 + (1 - 25 / 255) * frac;
  const rgb = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
  return (
    <div
      style={{ position: 'relative', height: `${height}px`, touchAction: 'none' }}
      id="chart_view"
      onPointerDown={(e) => move(e as unknown as PointerEvent)}
      onPointerMove={(e) => move(e as unknown as PointerEvent)}
      onPointerUp={(e) => e.pointerType !== 'mouse' && clear()}
      onPointerCancel={clear}
      onPointerLeave={clear}
    >
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: `${height}px`, display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={gid} x1="0" x2="1">
            <stop offset="0" stop-color={color} stop-opacity={25 / 255} />
            <stop offset="1" stop-color={color} />
          </linearGradient>
        </defs>
        <path d={d} fill="none" stroke={`url(#${gid})`} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        {hover !== null && <line x1={X(pts[hover][0])} x2={X(pts[hover][0])} y1="0" y2={height} stroke={color} stroke-opacity={80 / 255} stroke-dasharray="4 4" stroke-width="1" vector-effect="non-scaling-stroke" />}
      </svg>
      {hover !== null && (
        <span
          style={{
            position: 'absolute',
            left: `${frac * 100}%`,
            top: `${Y(pts[hover][1])}px`,
            width: '8px',
            height: '8px',
            marginLeft: '-4px',
            marginTop: '-4px',
            borderRadius: '50%',
            boxSizing: 'border-box',
            background: `rgba(${rgb.join(',')},${alpha})`,
            border: `1px solid rgba(${rgb.map((v) => Math.round(v * 0.9)).join(',')},${alpha})`,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}

/** ChartRangeSelector: 36 px options 24 px apart, a pill sliding to the selected one */
function RangeSelector({ range, onPick }: { range: ChartRangeId; onPick: (r: ChartRangeId) => void }) {
  const idx = CHART_RANGES.findIndex((r) => r.id === range);
  return (
    <div style={{ position: 'relative', display: 'flex' }} id="chart_range_selector">
      <span style={{ position: 'absolute', left: `${idx * 60}px`, top: 0, width: '36px', height: '36px', borderRadius: '999px', background: 'color-mix(in srgb, var(--on-surface) 9.8%, transparent)', transition: 'left 250ms cubic-bezier(.215, .61, .355, 1)' }} />
      {CHART_RANGES.map((r, i) => {
        const sel = r.id === range;
        return (
          <button type="button" id={`range_${r.id}`} aria-pressed={sel} onClick={() => !sel && onPick(r.id)} style={{ position: 'relative', flex: 'none', width: '36px', height: '36px', margin: `0 12px 0 ${i ? 12 : 0}px`, padding: 0, border: 0, background: 'none', cursor: 'pointer', fontWeight: sel ? 400 : 500, color: sel ? 'var(--on-surface)' : 'var(--on-surface-variant)', transition: 'color 250ms' }}>
            {r.id}
          </button>
        );
      })}
    </div>
  );
}

/** ChartViewCoinHeader: on the page with the small icon and the star, centered in the modal */
function CoinHeader({ c, favorite }: { c: Currency; favorite: boolean }) {
  const name = (
    <span class="rowx" style={{ gap: '5px' }}>
      <span style={{ fontSize: '20px', fontWeight: 500, color: 'var(--on-surface)' }}>{c.fullName ?? c.title}</span>
      <span style={{ borderRadius: '999px', background: 'var(--surface-container)', padding: '4px 8px', fontSize: '14px', color: 'var(--on-surface-variant)' }}>{c.title}</span>
    </span>
  );
  if (!favorite) return <div class="rowx" style={{ justifyContent: 'center' }}>{name}</div>;
  return (
    <div class="rowx" style={{ justifyContent: 'space-between', width: '100%' }}>
      <span class="rowx" style={{ gap: '10px' }}>
        <Img src={c.iconPath ?? undefined} size={30} />
        {name}
      </span>
      <Icon src="favorite.svg" size={16} color="var(--on-surface-variant)" />
    </div>
  );
}

/** ChartHeader: the coin, its price (or the touched point's), the change, the chart and the range */
function ChartHeader({ k, height, padding, centered, favorite }: { k: string; height: number; padding: number; centered: boolean; favorite: boolean }) {
  const s = charts.value;
  const lang = settings.value.languageCode;
  const [scrub, setScrub] = useState<{ price: string; time: string } | null>(null);
  const c = currency(k);
  const dec = priceDecimals(c);
  const loaded = s.phase === 'loaded';
  const pts = loaded ? s.prices[k] ?? [] : undefined;
  const last = loaded ? lastPrice(pts, dec) : null;
  const price = scrub?.price ?? (last ? toStringWithPrecision(last, dec, { fractionalDigits: 2, meaningfulDecimals: 2 }) : '...');
  const shown = /^-?\d+(\.\d+)?$/.test(price) ? withLocalSeparator(price, lang) : price;
  const ticker = fiatTicker(s);
  const change = loaded ? changeData(pts, dec) : null;
  const align = centered ? 'center' : 'flex-start';
  return (
    <div class="col" style={{ gap: '10px', alignItems: align, width: '100%' }} id={favorite ? 'charts_header' : 'chart_modal_header'}>
      <div class="col" style={{ gap: '10px', padding: '0 18px', alignItems: align, width: '100%', boxSizing: 'border-box' }}>
        {!favorite && <Img src={c.iconPath ?? undefined} size={60} />}
        <CoinHeader c={c} favorite={favorite} />
        <div class="rowx" style={{ gap: '6px', fontSize: '36px', whiteSpace: 'nowrap', maxWidth: '100%' }} id="chart_price">
          <span style={{ fontFamily: "'IBM Plex Sans', 'Wix Madefor Text', sans-serif", fontVariantNumeric: 'tabular-nums', color: scrub ? 'var(--primary)' : 'var(--on-surface)' }}>{shown}</span>
          <span style={{ color: scrub ? 'color-mix(in srgb, var(--primary) 50%, transparent)' : 'var(--on-surface-variant)' }}>{ticker}</span>
        </div>
        <div class="col" style={{ alignItems: align, width: '100%' }}>
          <div style={{ height: '36px', display: 'flex', alignItems: 'center', justifyContent: align }}>
            {loaded && (scrub ? <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontVariantNumeric: 'tabular-nums', fontWeight: 500, fontSize: '16px', color: 'var(--on-surface-variant)' }} id="chart_scrub_time">{scrub.time}</span> : <ChangeDisplay change={change!} ticker={ticker} />)}
          </div>
          {loaded ? (
            <div style={{ padding: `${padding}px 0`, width: '100%' }}>
              <LineChart pts={pts!} height={height} up={change!.up} onScrub={(p) => setScrub(p ? { price: scrubPrice(priceMoney(p[1], dec), dec), time: scrubTime(p[0]) } : null)} />
            </div>
          ) : (
            <div style={{ height: `${height + padding * 2}px`, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spinner />
            </div>
          )}
        </div>
      </div>
      <div style={{ width: '100%', height: '1px', background: 'color-mix(in srgb, var(--on-surface-variant) 50%, transparent)' }} />
      <div class="rowx" style={{ justifyContent: 'center', width: '100%' }}>
        <RangeSelector range={s.range} onPick={changeRange} />
      </div>
    </div>
  );
}

/** ChartsAssetCard's face */
function AssetCardFace({ k, handlers }: { k: string; handlers?: Record<string, unknown> }) {
  const s = charts.value;
  const c = currency(k);
  const dec = priceDecimals(c);
  const loaded = s.phase === 'loaded';
  const last = loaded ? lastPrice(s.prices[k], dec) : null;
  const price = gridPrice(last ? toStringWithPrecision(last, dec, { fractionalDigits: 2, trimZeros: false, meaningfulDecimals: 2 }) : '...');
  const shown = /^-?\d+(\.\d+)?$/.test(price) ? withLocalSeparator(price, settings.value.languageCode) : price;
  const change = loaded ? changeData(s.prices[k], dec) : null;
  return (
    <button type="button" class="col lp-target" id={handlers ? `chart_asset_${k}` : undefined} {...handlers} style={{ height: '105px', width: '100%', minWidth: 0, borderRadius: '16px', border: '1px solid var(--surface-container-highest)', background: 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))', padding: '12px', gap: '12px', cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start', boxSizing: 'border-box' }}>
      <div class="rowx" style={{ justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', gap: '4px' }}>
        <div class="col" style={{ minWidth: 0, flex: 1 }}>
          <span class="rowx" style={{ gap: '5px', fontSize: '12px', fontWeight: 500 }}>
            {change && <Icon src="price_change_arrow.svg" w={8} h={8} color={dirColor(change.up)} style={{ transform: change.up ? undefined : 'rotate(180deg)' }} />}
            {c.title.toUpperCase()}
          </span>
          <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.fullName ?? ''}</span>
        </div>
        {change && <ChangePill change={change} />}
      </div>
      <div class="rowx" style={{ justifyContent: 'space-between', width: '100%', gap: '8px' }}>
        <Img src={c.iconPath ?? undefined} size={24} />
        <FitText align="right">
          <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontVariantNumeric: 'tabular-nums', fontWeight: 500, fontSize: '20px' }} class="chart_asset_price">{shown}</span>
          <span style={{ marginLeft: '4px', color: 'var(--on-surface-variant)', fontWeight: 500, fontSize: '20px' }}>{fiatTicker(s)}</span>
        </FitText>
      </div>
    </button>
  );
}

/** ChartsAssetCard: a tap opens the chart, a long press Cake's menu (favorite; remove, unless it is the last) */
function AssetCard({ k, single }: { k: string; single: boolean }) {
  const favorite = charts.value.pinned === k;
  const lp = useLongPress((el) => {
    void showLongPressMenu(el, {
      child: () => <AssetCardFace k={k} />,
      items: [
        { label: t('favorite'), icon: 'favorite.svg', id: 'charts_menu_favorite', color: favorite ? 'var(--error)' : undefined, onSelected: (close) => { void pinAsset(k); close(); } },
        { label: t('remove'), icon: 'address_hide.svg', id: 'charts_menu_remove', color: single ? 'var(--on-surface-variant)' : undefined, onSelected: (close) => { if (!single) { void removeFollowed(k); close(); } } },
      ],
      footer: single ? t('cannot_remove_last_asset') : undefined,
    });
  });
  return <AssetCardFace k={k} handlers={{ ...lp, onClick: () => void openChartModal(k) }} />;
}

/** ChartsAssetGridHeader: add (Cake's currency picker) and the sort menu */
function GridHeader() {
  const sortRef = useRef<HTMLSpanElement>(null);
  const sortMenu = () => {
    const current = charts.peek().sort;
    void showLongPressMenu(sortRef.current!, {
      child: () => <ModernButton svg="sort.svg" size={36} iconSize={12} />,
      items: SORT_CRITERIA.map((c) => ({ label: t(c), icon: SORT_ICONS[c], id: `charts_sort_${c}`, color: c === current ? 'var(--primary)' : undefined, onSelected: (close: () => void) => { charts.value = { ...charts.peek(), sort: c }; close(); } })),
    });
  };
  return (
    <div class="rowx" style={{ justifyContent: 'space-between' }}>
      <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{t('followed_assets')}</span>
      <div class="rowx gap8">
        <ModernButton svg="add.svg" size={36} iconSize={16} label={t('add')} id="charts_add" onClick={async () => {
          const r = await pickSwapCurrency({ items: ALL_CURRENCIES.map((c) => builtin(c.key)), showStablesHeader: false });
          const key = r && builtinOf(r.currency)?.key;
          if (key) void addAsset(key);
        }} />
        <span ref={sortRef} style={{ display: 'inline-flex' }}>
          <ModernButton svg="sort.svg" size={36} iconSize={12} label={t('sort_by')} id="charts_sort" onClick={sortMenu} />
        </span>
      </div>
    </div>
  );
}

/** CupertinoSliverRefreshControl (refreshTriggerPullDistance 160): a touch pull past the top reloads the prices */
function usePullToRefresh(onRefresh: () => void) {
  const [pull, setPull] = useState(0);
  const from = useRef<number | null>(null);
  const last = useRef(0);
  const extent = useRef(0);
  return {
    pull,
    handlers: {
      onTouchStart: (e: TouchEvent) => {
        const el = e.currentTarget as HTMLElement;
        from.current = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
        last.current = from.current ?? 0;
        extent.current = 0;
      },
      onTouchMove: (e: TouchEvent) => {
        if (from.current === null) return;
        const el = e.currentTarget as HTMLElement;
        const y = e.touches[0].clientY;
        const dy = y - last.current;
        last.current = y;
        if (el.scrollTop > 0) return;
        // BouncingScrollPhysics: the overscroll grows ever slower (0.52 · (1 − fraction)²)
        const fraction = Math.min(1, extent.current / Math.max(1, el.clientHeight));
        extent.current = Math.max(0, extent.current + (dy > 0 ? dy * 0.52 * (1 - fraction) ** 2 : dy));
        setPull(extent.current);
      },
      onTouchEnd: () => {
        if (from.current !== null && extent.current >= 160) onRefresh();
        from.current = null;
        extent.current = 0;
        setPull(0);
      },
    },
  };
}

export function ChartsPage() {
  const s = charts.value;
  const { pull, handlers } = usePullToRefresh(refreshCharts);
  if (s.phase === 'disabled' || settings.value.fiatApiMode === 'disabled') {
    return (
      <div class="page" id="charts_page">
        <div class="page-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', textAlign: 'center' }}>
          <Img src="navbar/charts.svg" size={36} />
          <div style={{ fontSize: '24px', fontWeight: 600 }}>{t('charts_unavailable')}</div>
          <div>{t('charts_unavailable_desc')}</div>
        </div>
      </div>
    );
  }
  if (s.phase === 'initial') {
    return (
      <div class="page" id="charts_page">
        <div class="page-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px' }}>
          <Img src="navbar/charts.svg" size={36} />
          <Spinner />
        </div>
      </div>
    );
  }
  const list = listed(s);
  const single = list.length === 1;
  return (
    <div class="page" id="charts_page" style={{ background: 'linear-gradient(to bottom, var(--surface), var(--surface-dim))' }}>
      <div class="page-body" style={{ paddingTop: '16px', paddingBottom: '120px' }} {...handlers}>
        {pull > 0 && (
          <div style={{ height: `${Math.min(pull, 160)}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: Math.min(1, pull / 90), overflow: 'hidden' }} id="charts_pull">
            <Spinner />
          </div>
        )}
        <div class="col" style={{ gap: '24px' }}>
          <ChartHeader k={s.pinned} height={100} padding={22} centered={false} favorite />
          <div class="col" style={{ gap: '24px', padding: '0 18px' }}>
            <GridHeader />
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }} id="charts_grid">
              {list.map((k, i) => (
                <AssetCard key={`${k}:${i}`} k={k} single={single} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- the modal --

/** ChartModal; its Favorite pins the asset */
async function openChartModal(k: string) {
  const favorite = charts.peek().pinned === k;
  const pin = await showSheet<boolean>((close) => <ChartModal k={k} favorite={favorite} close={close} />);
  if (pin) void pinAsset(k);
}

function ChartModal({ k, favorite, close }: { k: string; favorite: boolean; close: (v?: boolean) => void }) {
  const c = currency(k);
  // canOpenBuySell: the wallet's balances have this currency (its own coin: tokens are other currency objects there)
  const canOpenBuySell = currentWallet.value?.currency.key === c.key;
  const dark = document.documentElement.dataset.theme !== 'light';
  return (
    <div class="col" style={{ background: 'var(--surface)', paddingBottom: '32px', overflowY: 'auto', minHeight: 0 }} id="chart_modal">
      <div style={{ padding: '18px 0 0 18px' }}>
        <ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} id="chart_modal_close" onClick={() => close()} />
      </div>
      <ChartHeader k={k} height={220} padding={32} centered favorite={false} />
      <div class="rowx" style={{ justifyContent: 'center', gap: '5%', marginTop: '48px' }}>
        {canOpenBuySell && (
          <>
            <ChartAction icon="plus.svg" label={t('buy')} onClick={() => { close(); nav.push(Routes.buySellPage, { mode: 'buy', currency: c.key }); }} />
            <ChartAction icon="sell.svg" label={t('sell')} onClick={() => { close(); nav.push(Routes.buySellPage, { mode: 'sell', currency: c.key }); }} />
          </>
        )}
        <ChartAction icon="exchange.svg" label={t('swap')} onClick={() => { close(); nav.push(Routes.exchange, { to: c.key }); }} />
        <ChartAction icon="favorite.svg" label={t('favorite')} id="chart_modal_favorite" gradient={favorite ? (dark ? ['#DF2626', '#980F0F'] : ['#EB5050', '#B22B2B']) : undefined} onClick={() => close(true)} />
      </div>
    </div>
  );
}

/** CoinActionButton: a 16 %-wide circle and its caption */
function ChartAction({ icon, label, onClick, gradient, id }: { icon: string; label: string; onClick: () => void; gradient?: [string, string]; id?: string }) {
  return (
    <button type="button" id={id} onClick={onClick} class="col" style={{ alignItems: 'center', gap: '8px', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
      <span style={{ width: 'min(16vw, 72px)', height: 'min(16vw, 72px)', minWidth: '58px', minHeight: '58px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: gradient ? `linear-gradient(${gradient[0]}, ${gradient[1]})` : 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))', border: '1px solid var(--surface-container-high)', color: gradient ? '#fff' : 'var(--primary)' }}>
        <Icon src={icon} size={36} />
      </span>
      <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{label}</span>
    </button>
  );
}

