// Charts tab (lib/new-ui/pages/charts_page.dart, lib/new-ui/model/charts/*).

import { signal } from '@preact/signals';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Icon, Img, ModernButton, Spinner, TopBar } from '../../components/core.tsx';
import { showSheet } from '../../components/overlays.tsx';
import { pickCurrency } from '../../components/currencyPicker.tsx';
import { settings } from '../../../app/settings.ts';
import { currentWallet } from '../../../app/app.ts';
import { fetchHistory } from '../../../app/prices.ts';
import { ALL_CURRENCIES, currency, type Currency } from '../../../coins/types.ts';
import { vault } from '../../../core/vault.ts';
import { nav } from '../../nav.ts';
import { Routes } from '../../routes.ts';

/** chart_range.dart: range -> [span seconds | 0 for ALL, precision seconds] */
const RANGES: { id: string; span: number; precision: number }[] = [
  { id: '1H', span: 3600, precision: 300 },
  { id: '1D', span: 86400, precision: 900 },
  { id: '7D', span: 7 * 86400, precision: 3600 },
  { id: '30D', span: 30 * 86400, precision: 4 * 3600 },
  { id: '1Y', span: 365 * 86400, precision: 86400 },
  { id: 'ALL', span: 0, precision: 86400 },
];

/** price_data_sort_criteria.dart market-cap order (subset used for sorting) */
const MARKETCAP_ORDER = ['BTC', 'ETH', 'USDT', 'XRP', 'BNB', 'SOL', 'USDC', 'TRX', 'DOGE', 'ADA', 'BCH', 'LINK', 'XLM', 'LTC', 'AVAX', 'HBAR', 'SHIB', 'TON', 'DAI', 'XMR', 'DOT', 'UNI', 'PEPE', 'AAVE', 'NEAR', 'ETC', 'ZEC', 'POL', 'ARB', 'DCR', 'XNO'];

interface Followed {
  keys: string[];
  pinned: string;
  sort: 'marketcap' | 'gains' | 'losses' | 'alphabetical';
}

const followed = signal<Followed>({ keys: ['btc', 'xmr', 'eth'], pinned: 'btc', sort: 'marketcap' });
const series = signal<Record<string, [number, number][]>>({});

async function loadFollowed() {
  const f = await vault.get<Followed>('charts:assets').catch(() => undefined);
  if (f) followed.value = f;
}

async function saveFollowed(f: Followed) {
  followed.value = f;
  await vault.put('charts:assets', f);
}

async function loadSeries(key: string, rangeId: string) {
  const c = currency(key);
  const r = RANGES.find((x) => x.id === rangeId)!;
  const now = Math.floor(Date.now() / 1000);
  const start = r.span ? Math.floor((now - r.span) / r.precision) * r.precision : 0;
  const pts = await fetchHistory(`crypto.${c.title}`, start, r.precision).catch(() => []);
  series.value = { ...series.value, [`${key}:${rangeId}`]: pts };
}

function dirColor(up: boolean): string {
  const dark = document.documentElement.dataset.theme !== 'light';
  return up ? (dark ? '#6FC84E' : '#00C317') : dark ? '#EA696F' : '#F9434C';
}

function fmtPrice(p: number): string {
  if (p > 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (p < 1) return String(Number(p.toPrecision(4)));
  return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function LineChart({ pts, height, onScrub }: { pts: [number, number][]; height: number; onScrub?: (p: [number, number] | null) => void }) {
  const w = 400;
  if (pts.length < 2) return <div style={{ height: `${height}px` }} />;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const x0 = pts[0][0];
  const x1 = pts[pts.length - 1][0];
  const X = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * w;
  const Y = (y: number) => height - 4 - ((y - min) / Math.max(1e-12, max - min)) * (height - 8);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  const color = dirColor(up);
  const [hover, setHover] = useState<number | null>(null);
  const move = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * w;
    let best = 0;
    for (let i = 0; i < pts.length; i++) if (Math.abs(X(pts[i][0]) - fx) < Math.abs(X(pts[best][0]) - fx)) best = i;
    setHover(best);
    onScrub?.(pts[best]);
  };
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: `${height}px`, touchAction: 'none' }} onPointerMove={move as any} onPointerLeave={() => { setHover(null); onScrub?.(null); }}>
      <defs>
        <linearGradient id="cl" x1="0" x2="1">
          <stop offset="0" stop-color={color} stop-opacity="0.1" />
          <stop offset="1" stop-color={color} />
        </linearGradient>
      </defs>
      <path d={d} fill="none" stroke="url(#cl)" stroke-width="1.5" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      {hover !== null && <line x1={X(pts[hover][0])} x2={X(pts[hover][0])} y1="0" y2={height} stroke={color} stroke-dasharray="4 4" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0.8" />}
    </svg>
  );
}

function ChangePill({ pct }: { pct: number }) {
  const up = pct >= 0;
  const c = dirColor(up);
  return <span style={{ background: `color-mix(in srgb, ${c} 20%, transparent)`, color: c, borderRadius: '999px', padding: '2.5px 8px 2.5px 4px', fontSize: '12px', whiteSpace: 'nowrap' }}>{`${up ? '+' : '-'} ${Math.abs(pct).toFixed(2)}%`}</span>;
}

function ChartHeader({ c, range, setRange, height = 100 }: { c: Currency; range: string; setRange: (r: string) => void; height?: number }) {
  const pts = series.value[`${c.key}:${range}`];
  const [scrub, setScrub] = useState<[number, number] | null>(null);
  useEffect(() => void loadSeries(c.key, range), [c.key, range, settings.value.fiatCurrency]);
  const fiat = settings.value.fiatCurrency;
  const last = pts?.[pts.length - 1]?.[1];
  const first = pts?.[0]?.[1];
  const shown = scrub?.[1] ?? last;
  const change = last && first ? last - first : 0;
  const pct = first ? (change / first) * 100 : 0;
  return (
    <div class="col" style={{ gap: '10px', padding: '0 18px' }}>
      <div class="rowx" style={{ justifyContent: 'space-between' }}>
        <div class="rowx" style={{ gap: '10px' }}>
          <Img src={c.iconPath ?? undefined} size={30} round />
          <span style={{ fontSize: '20px', fontWeight: 500 }}>{c.fullName}</span>
          <span class="pill sm" style={{ cursor: 'default', color: 'var(--on-surface-variant)', fontSize: '14px' }}>{c.title}</span>
        </div>
        <Icon src="favorite.svg" size={16} color="var(--on-surface-variant)" />
      </div>
      <div style={{ fontFamily: "'IBM Plex Sans', 'Wix Madefor Text', sans-serif", fontSize: '36px', fontVariantNumeric: 'tabular-nums', color: scrub ? 'var(--primary)' : 'var(--on-surface)' }} id="chart_price">
        {shown !== undefined ? fmtPrice(shown) : '—'} <span style={{ color: scrub ? 'color-mix(in srgb, var(--primary) 50%, transparent)' : 'var(--on-surface-variant)' }}>{fiat}</span>
      </div>
      <div style={{ height: '36px', display: 'flex', alignItems: 'center', gap: '10px' }}>
        {scrub ? (
          <span style={{ fontSize: '16px', fontWeight: 500, color: 'var(--on-surface-variant)' }}>{new Date(scrub[0] * 1000).toLocaleString()}</span>
        ) : pts?.length ? (
          <>
            <span style={{ fontSize: '16px', color: dirColor(change >= 0) }}>{`${change >= 0 ? '+' : '-'}${fiat} ${fmtPrice(Math.abs(change))}`}</span>
            <ChangePill pct={pct} />
          </>
        ) : null}
      </div>
      <div style={{ padding: '22px 0' }}>{pts ? <LineChart pts={pts} height={height} onScrub={setScrub} /> : <div style={{ height: `${height}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>}</div>
      <div style={{ height: '1px', background: 'color-mix(in srgb, var(--on-surface-variant) 50%, transparent)' }} />
      <div class="rowx" style={{ justifyContent: 'center', gap: '24px' }}>
        {RANGES.map((r) => (
          <button type="button" onClick={() => setRange(r.id)} id={`range_${r.id}`} style={{ width: '36px', height: '36px', borderRadius: '50%', border: 0, cursor: 'pointer', background: range === r.id ? 'color-mix(in srgb, var(--on-surface) 10%, transparent)' : 'none', color: range === r.id ? 'var(--on-surface)' : 'var(--on-surface-variant)', fontWeight: range === r.id ? 400 : 500 }}>{r.id}</button>
        ))}
      </div>
    </div>
  );
}

function AssetCard({ c, onClick }: { c: Currency; onClick: () => void }) {
  const pts = series.value[`${c.key}:1D`];
  useEffect(() => {
    if (!pts) void loadSeries(c.key, '1D');
  }, [c.key]);
  const last = pts?.[pts.length - 1]?.[1];
  const first = pts?.[0]?.[1];
  const pct = last && first ? ((last - first) / first) * 100 : 0;
  return (
    <button type="button" onClick={onClick} class="col" style={{ height: '105px', borderRadius: '16px', border: '1px solid var(--surface-container-highest)', background: 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))', padding: '12px', gap: '12px', cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start' }}>
      <div class="rowx" style={{ justifyContent: 'space-between', width: '100%' }}>
        <div class="col" style={{ minWidth: 0 }}>
          <span class="rowx" style={{ gap: '5px', fontSize: '12px', fontWeight: 500 }}>
            <Icon src="price_change_arrow.svg" size={8} color={dirColor(pct >= 0)} style={{ transform: pct < 0 ? 'rotate(180deg)' : undefined }} />
            {c.title}
          </span>
          <span class="muted" style={{ fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.fullName}</span>
        </div>
        {pts?.length ? <ChangePill pct={pct} /> : null}
      </div>
      <div class="rowx" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Img src={c.iconPath ?? undefined} size={24} round />
        <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: '20px', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
          {last !== undefined ? fmtPrice(last) : '—'} <span class="muted">{settings.value.fiatCurrency}</span>
        </span>
      </div>
    </button>
  );
}

export function ChartsPage() {
  const [range, setRange] = useState('30D');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void loadFollowed().then(() => setLoaded(true));
  }, []);
  const f = followed.value;
  const pinned = currency(f.pinned);
  const assets = useMemo(() => {
    const list = f.keys.map((k) => currency(k));
    const change = (c: Currency) => {
      const p = series.value[`${c.key}:1D`];
      return p?.length ? (p[p.length - 1][1] - p[0][1]) / p[0][1] : 0;
    };
    switch (f.sort) {
      case 'alphabetical':
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case 'gains':
        return list.sort((a, b) => change(b) - change(a));
      case 'losses':
        return list.sort((a, b) => change(a) - change(b));
      default:
        return list.sort((a, b) => (MARKETCAP_ORDER.indexOf(a.title) + 1 || 999) - (MARKETCAP_ORDER.indexOf(b.title) + 1 || 999));
    }
  }, [f, series.value]);
  if (settings.value.fiatApiMode === 'disabled') {
    return (
      <div class="page" id="charts_page">
        <div class="page-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', textAlign: 'center' }}>
          <Icon src="navbar/charts.svg" size={36} color="var(--on-surface-variant)" />
          <div style={{ fontSize: '24px', fontWeight: 600 }}>{t('charts_unavailable')}</div>
          <div class="muted">{t('charts_unavailable_desc')}</div>
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div class="page" id="charts_page">
        <div class="page-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px' }}>
          <Icon src="navbar/charts.svg" size={36} color="var(--primary)" />
          <Spinner />
        </div>
      </div>
    );
  }
  return (
    <div class="page" id="charts_page">
      <div class="page-body" style={{ paddingTop: '16px', paddingBottom: '120px' }}>
        <div class="col" style={{ gap: '24px' }}>
          <ChartHeader c={pinned} range={range} setRange={setRange} />
          <div class="col" style={{ gap: '24px', padding: '0 18px' }}>
            <div class="rowx" style={{ justifyContent: 'space-between' }}>
              <span class="muted" style={{ fontSize: '12px' }}>{t('followed_assets')}</span>
              <div class="rowx gap8">
                <ModernButton svg="add.svg" size={36} iconSize={16} label={t('add')} onClick={async () => {
                  const c = await pickCurrency(ALL_CURRENCIES.filter((x) => !x.tag));
                  if (c && !f.keys.includes(c.key)) await saveFollowed({ ...f, keys: [...f.keys, c.key] });
                }} />
                <ModernButton svg="sort.svg" size={36} iconSize={12} label={t('sort_by')} onClick={() => showSheet((close) => (
                  <div style={{ padding: '0 18px 24px' }}>
                    <TopBar title={t('sort_by')} onClose={() => close()} />
                    <div class="list">
                      {(['marketcap', 'gains', 'losses', 'alphabetical'] as const).map((s) => (
                        <button type="button" class="row tap" onClick={() => { void saveFollowed({ ...followed.value, sort: s }); close(); }} style={{ color: followed.value.sort === s ? 'var(--primary)' : undefined }}>
                          <Icon src={`charts_sort_criteria/${s === 'alphabetical' ? 'alpha' : s}.svg`} size={20} />
                          <span class="lbl">{t(s)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              {assets.map((c) => <AssetCard c={c} onClick={() => openChartModal(c)} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function openChartModal(c: Currency) {
  return showSheet((close) => <ChartModal c={c} close={close} />, { full: true });
}

function ChartModal({ c, close }: { c: Currency; close: () => void }) {
  const [range, setRange] = useState('30D');
  const f = followed.value;
  const isFav = f.pinned === c.key;
  // canOpenBuySell: the wallet's balances have this currency (its own coin: tokens are other currency objects there)
  const canOpenBuySell = currentWallet.value?.currency.key === c.key;
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }}>
      <TopBar onClose={close} />
      <div class="page-body" style={{ paddingBottom: '32px' }}>
        <ChartHeader c={c} range={range} setRange={setRange} height={220} />
        <div class="rowx" style={{ justifyContent: 'center', gap: '5%', marginTop: '48px' }}>
          {canOpenBuySell && (
            <>
              <ChartAction icon="plus.svg" label={t('buy')} onClick={() => { close(); nav.push(Routes.buySellPage, { mode: 'buy', currency: c.key }); }} />
              <ChartAction icon="sell.svg" label={t('sell')} onClick={() => { close(); nav.push(Routes.buySellPage, { mode: 'sell', currency: c.key }); }} />
            </>
          )}
          <ChartAction icon="exchange.svg" label={t('swap')} onClick={() => { close(); nav.push(Routes.exchange, { to: c.key }); }} />
          <ChartAction icon="favorite.svg" label={t('favorite')} active={isFav} onClick={() => { void saveFollowed({ ...f, pinned: c.key }); close(); }} />
          {f.keys.length > 1 && <ChartAction icon="address_hide.svg" label={t('remove')} onClick={() => { void saveFollowed({ ...f, keys: f.keys.filter((k) => k !== c.key), pinned: f.pinned === c.key ? f.keys.find((k) => k !== c.key)! : f.pinned }); close(); }} />}
        </div>
      </div>
    </div>
  );
}

function ChartAction({ icon, label, onClick, active }: { icon: string; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} class="col" style={{ alignItems: 'center', gap: '8px', background: 'none', border: 0, cursor: 'pointer' }}>
      <span style={{ width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: active ? 'linear-gradient(#DF2626, #980F0F)' : 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))', border: '1px solid var(--surface-container-high)', color: active ? '#fff' : 'var(--primary)' }}>
        <Icon src={icon} size={32} />
      </span>
      <span class="muted" style={{ fontSize: '12px' }}>{label}</span>
    </button>
  );
}
