// Balance cards (lib/new-ui/widgets/coins_page/cards/*, cw_core/lib/card_design.dart).

import type { ComponentChildren } from 'preact';
import { Icon, MIcon, asset } from '../../components/core.tsx';

export type Combo = 'light' | 'dark' | 'black';
export type BackgroundType = 'gradientOnly' | 'svgIcon' | 'svgFull';

export interface Gradient {
  from: string;
  to: string;
}

/** CardDesign (cw_core/lib/card_design.dart) */
export interface CardDesign extends Gradient {
  type: BackgroundType;
  /** svgIcon: the corner icon; svgFull: the whole-card artwork (asset paths) */
  image: string;
  combo: Combo;
  preColored?: boolean;
}

/** BalanceCardStyleSettings: what the card customizer stores per wallet (and account) */
export interface CardStyle {
  gradientIndex: number;
  useSpecialDesign: boolean;
  iconStyleIndex: number;
  isGradientOnly: boolean;
}

const BLANK = 'assets/new-ui/blank.svg';
const BLUE: Gradient = { from: '#4EBEFF', to: '#1D78FF' };

/** CardDesign.allGradients and preferredColorCombinations */
export const CARD_GRADIENTS: (Gradient & { id: string; combo: Combo })[] = [
  { id: 'orange', from: '#FF7C02', to: '#FF5602', combo: 'dark' },
  { id: 'yellow', from: '#FFD000', to: '#FFAA00', combo: 'dark' },
  { id: 'green', from: '#5AA438', to: '#5AA438', combo: 'light' },
  { id: 'blue', from: '#4EBEFF', to: '#1D78FF', combo: 'dark' },
  { id: 'purple', from: '#9E30FF', to: '#7100BD', combo: 'light' },
  { id: 'pink', from: '#FF6CD3', to: '#F200A9', combo: 'dark' },
  { id: 'red', from: '#FF2222', to: '#A10000', combo: 'light' },
  { id: 'silver', from: '#E0E8FF', to: '#6D8ADE', combo: 'dark' },
  { id: 'gold', from: '#E9CA74', to: '#886A14', combo: 'dark' },
  { id: 'black', from: '#2A2A2A', to: '#000000', combo: 'black' },
];

/** genericDefault: blue, blank icon */
export const GENERIC_DESIGN: CardDesign = { ...BLUE, type: 'svgIcon', image: BLANK, combo: 'dark' };
export const GRADIENT_ONLY_DESIGN: CardDesign = { ...BLUE, type: 'gradientOnly', image: BLANK, combo: 'dark' };

/** forCurrencySpecial (card_design.dart:173-329): gradient, artwork in balance_card_backgrounds, text colors */
const SPECIAL: Record<string, [string, string, string, Combo]> = {
  btc: ['#FFBF00', '#FF6A00', 'bitcoin.svg', 'dark'],
  btcln: ['#FFBF00', '#FF6A00', 'lightning.svg', 'dark'],
  eth: ['#6259FF', '#3B20E6', 'ethereum.svg', 'light'],
  xmr: ['#FF5900', '#E62E00', 'monero.svg', 'dark'],
  ltc: ['#2145BF', '#072071', 'litecoin.svg', 'light'],
  trx: ['#FF1313', '#B40000', 'tron.svg', 'light'],
  sol: ['#4701AA', '#19004B', 'solana.svg', 'light'],
  bch: ['#36DA4C', '#008D57', 'bitcoin-cash.svg', 'dark'],
  wow: ['#FF6CD3', '#F200A9', 'wownero.svg', 'dark'],
  doge: ['#CBA818', '#885D00', 'dogecoin.svg', 'dark'],
  nano: ['#209CE9', '#0073CB', 'nano.svg', 'dark'],
  maticpoly: ['#863FE3', '#59098E', 'polygon.svg', 'light'],
  dcr: ['#2871FF', '#0057FF', 'decred.svg', 'light'],
  zano: ['#0004B4', '#170069', 'zano.svg', 'black'],
  baseEth: ['#003CFF', '#000087', 'base.svg', 'light'],
  arbEth: ['#173F76', '#031A39', 'arbitrum.svg', 'light'],
  zec: ['#F6C527', '#CD8C00', 'zcash.svg', 'dark'],
  bnb: ['#603000', '#F0B90B', 'bnb.svg', 'light'],
  robEth: ['#BDFE00', '#85BE00', 'robinhood.svg', 'dark'],
};

/** iconDesignsForCurrencies: balance_card_icons/<name>.svg */
const ICON_DESIGN: Record<string, string> = {
  xmr: 'monero', btc: 'bitcoin', eth: 'ethereum', ltc: 'litecoin', btcln: 'lightning', trx: 'tron', sol: 'solana', maticpoly: 'polygon', baseEth: 'base', bch: 'bitcoin_cash',
  wow: 'wownero', doge: 'dogecoin', nano: 'nano', zano: 'zano', arbEth: 'arbitrum', zec: 'zcash', dcr: 'decred', bnb: 'bnb', robEth: 'robinhood',
};

/** _iconNames: ticker, long name, and the files that differ from them */
const ICON_NAMES: Record<string, { ticker: string; longName: string; outline?: string; chain?: string; og?: string }> = {
  arbEth: { ticker: 'arb', longName: 'arbitrum' },
  baseEth: { ticker: 'base', longName: 'base', chain: 'base_icon' },
  robEth: { ticker: 'rob', longName: 'robinhood' },
  bch: { ticker: 'bch', longName: 'bitcoin_cash', chain: 'bitcoin-cash' },
  btc: { ticker: 'btc', longName: 'bitcoin', outline: 'BTC' },
  bnb: { ticker: 'bnb', longName: 'bnb' },
  dcr: { ticker: 'dcr', longName: 'decred' },
  doge: { ticker: 'doge', longName: 'dogecoin' },
  eth: { ticker: 'eth', longName: 'ethereum' },
  btcln: { ticker: 'ln', longName: 'lightning' },
  ltc: { ticker: 'ltc', longName: 'litecoin' },
  xmr: { ticker: 'xmr', longName: 'monero', og: 'assets/images/xmr-og.webp' },
  nano: { ticker: 'xno', longName: 'nano' },
  maticpoly: { ticker: 'pol', longName: 'polygon' },
  sol: { ticker: 'sol', longName: 'solana' },
  trx: { ticker: 'trx', longName: 'tron', og: 'assets/new-ui/card_icons/og_icons/tron-og.svg' },
  zano: { ticker: 'zano', longName: 'zano' },
  zec: { ticker: 'zec', longName: 'zcash' },
};

export function specialDesign(cur: string): CardDesign | undefined {
  const x = SPECIAL[cur];
  return x ? { from: x[0], to: x[1], type: 'svgFull', image: `assets/new-ui/balance_card_backgrounds/${x[2]}`, combo: x[3] } : undefined;
}

/** forCurrencyIcon: the classic icon on a black gradient (always recolored before use) */
export function iconDesign(cur: string): CardDesign {
  const n = ICON_DESIGN[cur];
  return n ? { from: '#000000', to: '#000000', type: 'svgIcon', image: `assets/new-ui/balance_card_icons/${n}.svg`, combo: 'dark' } : GENERIC_DESIGN;
}

/** iconPathsForWalletType: symbol, outline, classic, chain, OG, Cake */
export function iconPaths(cur: string): { path: string; preColored: boolean }[] {
  const n = ICON_NAMES[cur];
  if (!n) return [];
  return [
    { path: `assets/new-ui/card_icons/symbol_icons/${n.ticker}-symbol.svg`, preColored: false },
    { path: `assets/new-ui/card_icons/outline_icons/${n.outline ?? n.ticker}-outline.svg`, preColored: false },
    { path: `assets/new-ui/balance_card_icons/${n.longName}.svg`, preColored: false },
    { path: `assets/new-ui/card_icons/chain_icons/${n.chain ?? n.longName}.svg`, preColored: true },
    { path: n.og ?? `assets/new-ui/card_icons/og_icons/${n.ticker}-og.svg`, preColored: true },
    { path: 'assets/new-ui/balance_card_icons/cake-card-icon.svg', preColored: false },
  ];
}

const sameGradient = (a: Gradient, b: Gradient) => a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase();

export function preferredCombo(g: Gradient): Combo | undefined {
  return CARD_GRADIENTS.find((x) => sameGradient(x, g))?.combo;
}

export const withGradient = (d: CardDesign, g: Gradient): CardDesign => ({ ...d, from: g.from, to: g.to, combo: preferredCombo(g) ?? d.combo });
export const withGradientAndCombo = (d: CardDesign, g: Gradient, combo: Combo): CardDesign => ({ ...d, from: g.from, to: g.to, combo });
export const withIcon = (d: CardDesign, icon: { path: string; preColored: boolean }): CardDesign => ({ ...d, image: icon.path, preColored: icon.preColored });

function withIconStyle(d: CardDesign, index: number, cur: string): CardDesign {
  const p = iconPaths(cur);
  return index >= 0 && index < p.length ? withIcon(d, p[index]) : d;
}

/** the customizer's colors: the ten gradients, then the coin's own */
export function availableGradients(cur: string): Gradient[] {
  const sp = specialDesign(cur);
  return [...CARD_GRADIENTS.map(({ from, to }) => ({ from, to })), ...(sp ? [{ from: sp.from, to: sp.to }] : [])];
}

/** gradientForStoredIndex */
function gradientForIndex(i: number, cur: string): Gradient {
  if (i >= 0 && i < CARD_GRADIENTS.length) return CARD_GRADIENTS[i];
  const sp = specialDesign(cur);
  if (i === CARD_GRADIENTS.length && sp) return sp;
  return BLUE;
}

export function isCardStyle(x: unknown): x is CardStyle {
  return !!x && typeof (x as CardStyle).gradientIndex === 'number';
}

/** CardDesign.fromStyleSettings */
export function designFromStyle(style: unknown, cur: string): CardDesign {
  const special = specialDesign(cur);
  if (!isCardStyle(style)) return special ?? GENERIC_DESIGN;
  if (style.isGradientOnly) {
    const g = gradientForIndex(style.gradientIndex, cur);
    return withGradientAndCombo(GRADIENT_ONLY_DESIGN, g, preferredCombo(g) ?? special?.combo ?? GRADIENT_ONLY_DESIGN.combo);
  }
  if (style.useSpecialDesign && style.gradientIndex !== -1) return withGradient(special ?? GENERIC_DESIGN, gradientForIndex(style.gradientIndex, cur));
  if (!style.useSpecialDesign && style.gradientIndex === -1) {
    const sp = special ?? GENERIC_DESIGN;
    return withIconStyle(withGradientAndCombo(iconDesign(cur), sp, sp.combo), style.iconStyleIndex, cur);
  }
  if (style.useSpecialDesign) return special ?? GENERIC_DESIGN;
  const icon = iconDesign(cur);
  const g = gradientForIndex(style.gradientIndex, cur);
  return withIconStyle(withGradientAndCombo(icon, g, preferredCombo(g) ?? special?.combo ?? icon.combo), style.iconStyleIndex, cur);
}

/** the card style key: per wallet, and per account for wallets with accounts (accountIndex -1 otherwise) */
export function cardStyleKey(w: { id: string; type: string; currentAccount: { value: number } }): string {
  return `${w.id}:${w.type === 'monero' || w.type === 'wownero' || w.type === 'bitcoin' ? w.currentAccount.value : -1}`;
}

/** a card's stored style; an account 0 without one takes the wallet card's (Bitcoin's, saved before it had accounts) */
export function storedCardStyle(designs: Record<string, unknown>, key: string): unknown {
  if (designs[key] !== undefined) return designs[key];
  return key.endsWith(':0') ? designs[`${key.slice(0, -2)}:-1`] : undefined;
}

/**
 * AccountEditOrCreateViewModel._saveRandomCardDesign: a new account gets the coin's own design in a gradient none
 * of the wallet's stored card styles uses (any gradient once all are taken)
 */
export function newAccountStyle(designs: Record<string, unknown>, walletId: string, cur: string, random = Math.random): CardStyle {
  const used = Object.entries(designs)
    .filter(([k]) => k.startsWith(`${walletId}:`))
    .map(([, v]) => designFromStyle(v, cur));
  const all = CARD_GRADIENTS.map((g, i) => ({ g, i }));
  const free = all.filter(({ g }) => !used.some((d) => sameGradient(d, g)));
  const pool = free.length ? free : all;
  const pick = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return { gradientIndex: pick.i, useSpecialDesign: !!specialDesign(cur), iconStyleIndex: 0, isGradientOnly: false };
}

export const COMBOS: Record<Combo, { text: string; secondary: string; chip: string }> = {
  light: { text: 'rgba(255,255,255,.784)', secondary: 'rgba(255,255,255,.54)', chip: 'rgba(0,0,0,.784)' },
  dark: { text: 'rgba(0,0,0,.784)', secondary: 'rgba(0,0,0,.45)', chip: 'rgba(255,255,255,.784)' },
  black: { text: 'rgba(255,255,255,.784)', secondary: 'rgba(255,255,255,.54)', chip: 'rgba(255,255,255,.784)' },
};

/** the artwork of a card: the full background (svgFull) or the corner icon (svgIcon, 15 % of the width, at 33 % unless pre-colored) */
export function CardArtwork({ design }: { design: CardDesign }) {
  if (design.type === 'svgFull') return <img src={asset(design.image)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', transition: 'opacity 300ms' }} draggable={false} />;
  if (design.type === 'svgIcon' && design.image !== BLANK) return <img src={asset(design.image)} alt="" style={{ position: 'absolute', right: '5%', bottom: '5%', width: '15%', aspectRatio: '1', objectFit: 'contain', opacity: design.preColored ? 1 : 0.33 }} draggable={false} />;
  return null;
}

/** a small BalanceCard showing only its design (BalanceCard with just a width and a radius) */
export function MiniCard({ design, width = 50, radius = 5 }: { design: CardDesign; width?: number; radius?: number }) {
  return (
    <span style={{ position: 'relative', display: 'block', flex: 'none', width: `${width}px`, height: `${Math.round(width * 0.62)}px`, borderRadius: `${radius}px`, overflow: 'hidden', background: `linear-gradient(to bottom, ${design.from}, ${design.to})` }}>
      <CardArtwork design={design} />
    </span>
  );
}

export function BalanceCard({ design, label, labelDim, amount, asset, fiat, chips, onLongPress, onMenu, hidden, width = 380 }: { design: CardDesign; label: string; labelDim?: boolean; amount: string; asset: string; fiat?: string; chips?: ComponentChildren; onLongPress?: () => void; onMenu?: () => void; hidden?: boolean; width?: number }) {
  const c = COMBOS[design.combo];
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    if (!onLongPress) return;
    pressTimer = setTimeout(() => onLongPress(), 550);
  };
  const cancel = () => clearTimeout(pressTimer);
  return (
    <div
      class="balance-card"
      id="balance_card"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
        onLongPress?.();
      }}
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: `${width}px`,
        aspectRatio: '1 / 0.62',
        borderRadius: '20px',
        border: '1px solid rgba(255,255,255,.27)',
        background: `linear-gradient(to bottom, ${design.from}, ${design.to})`,
        transition: 'background 300ms',
        overflow: 'hidden',
        color: c.text,
        userSelect: 'none',
        boxShadow: '0 8px 24px rgba(0,0,0,.25)',
      }}
    >
      <CardArtwork design={design} />
      <div style={{ position: 'absolute', inset: 0, padding: '5%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '16px', fontWeight: 500, opacity: labelDim ? 0.5 : 1 }} id="balance_card_label">{label}</div>
        <div>
          <div class="rowx" style={{ gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '28px', fontWeight: 500, letterSpacing: '-0.4px' }} id="balance_card_amount">{hidden ? '●●●●●●' : amount}</span>
            <span style={{ fontSize: '28px', fontWeight: 400, letterSpacing: '-0.4px', color: c.secondary }}>{asset}</span>
          </div>
          {fiat !== undefined && <div style={{ fontSize: '15px', color: c.secondary, marginTop: '2px' }}>{hidden ? '●●●●●' : fiat}</div>}
        </div>
        <div class="rowx" style={{ minHeight: '30px' }}>{chips && <div class="rowx gap8" style={{ ['--chip-bg' as any]: c.chip }}>{chips}</div>}</div>
      </div>
      {onMenu && (
        <button type="button" aria-label="Menu" onClick={onMenu} style={{ position: 'absolute', top: '8px', right: '8px', width: '40px', height: '40px', border: 0, background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon src="3dots_vertical.svg" w={4} h={15} color={c.secondary} />
        </button>
      )}
    </div>
  );
}

/** cards_view.dart action chip: bg = backgroundImageColor @ 75 %, label = textColor, icon = textColorSecondary */
export function CardChip({ label, onClick, icon, combo }: { label: string; onClick?: () => void; icon?: string; combo: Combo }) {
  const c = COMBOS[combo];
  return (
    <button type="button" onClick={onClick} id="balance_card_chip" style={{ border: 0, cursor: 'pointer', borderRadius: '999px', background: `color-mix(in srgb, ${c.chip} 75%, transparent)`, color: c.text, padding: '5px 5px 5px 10px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '16px' }}>
      <span>{label}</span>
      {icon ? <Icon src={icon} size={12} color={c.secondary} /> : <MIcon name="chevronRight" size={16} color={c.secondary} />}
    </button>
  );
}
