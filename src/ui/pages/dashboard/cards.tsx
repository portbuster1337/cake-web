// Balance cards (lib/new-ui/widgets/coins_page/cards/*, cw_core/lib/card_design.dart).

import type { ComponentChildren } from 'preact';
import { Icon, MIcon } from '../../components/core.tsx';

type Combo = 'light' | 'dark' | 'black';

export interface CardDesign {
  from: string;
  to: string;
  bg?: string;
  combo: Combo;
}

/** forCurrencySpecial (card_design.dart:173-329) */
export const SPECIAL_DESIGNS: Record<string, CardDesign> = {
  btc: { from: '#FFBF00', to: '#FF6A00', bg: 'bitcoin.svg', combo: 'dark' },
  btcln: { from: '#FFBF00', to: '#FF6A00', bg: 'lightning.svg', combo: 'dark' },
  eth: { from: '#6259FF', to: '#3B20E6', bg: 'ethereum.svg', combo: 'light' },
  xmr: { from: '#FF5900', to: '#E62E00', bg: 'monero.svg', combo: 'dark' },
  ltc: { from: '#2145BF', to: '#072071', bg: 'litecoin.svg', combo: 'light' },
  trx: { from: '#FF1313', to: '#B40000', bg: 'tron.svg', combo: 'light' },
  sol: { from: '#4701AA', to: '#19004B', bg: 'solana.svg', combo: 'light' },
  bch: { from: '#36DA4C', to: '#008D57', bg: 'bitcoin-cash.svg', combo: 'dark' },
  wow: { from: '#FF6CD3', to: '#F200A9', bg: 'wownero.svg', combo: 'dark' },
  doge: { from: '#CBA818', to: '#885D00', bg: 'dogecoin.svg', combo: 'dark' },
  nano: { from: '#209CE9', to: '#0073CB', bg: 'nano.svg', combo: 'dark' },
  maticpoly: { from: '#863FE3', to: '#59098E', bg: 'polygon.svg', combo: 'light' },
  dcr: { from: '#2871FF', to: '#0057FF', bg: 'decred.svg', combo: 'light' },
  zano: { from: '#0004B4', to: '#170069', bg: 'zano.svg', combo: 'black' },
  baseEth: { from: '#003CFF', to: '#000087', bg: 'base.svg', combo: 'light' },
  arbEth: { from: '#173F76', to: '#031A39', bg: 'arbitrum.svg', combo: 'light' },
  zec: { from: '#F6C527', to: '#CD8C00', bg: 'zcash.svg', combo: 'dark' },
  bnb: { from: '#603000', to: '#F0B90B', bg: 'bnb.svg', combo: 'light' },
  robEth: { from: '#BDFE00', to: '#85BE00', bg: 'robinhood.svg', combo: 'dark' },
};

export const GENERIC_DESIGN: CardDesign = { from: '#4EBEFF', to: '#1D78FF', combo: 'dark' };

/** card_design.dart gradients for the customizer */
export const CARD_GRADIENTS: { id: string; from: string; to: string; combo: Combo }[] = [
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

const COMBOS: Record<Combo, { text: string; secondary: string; chip: string }> = {
  light: { text: 'rgba(255,255,255,.784)', secondary: 'rgba(255,255,255,.54)', chip: 'rgba(0,0,0,.784)' },
  dark: { text: 'rgba(0,0,0,.784)', secondary: 'rgba(0,0,0,.45)', chip: 'rgba(255,255,255,.784)' },
  black: { text: 'rgba(255,255,255,.784)', secondary: 'rgba(255,255,255,.54)', chip: 'rgba(255,255,255,.784)' },
};

export function designFor(currencyKey: string, custom?: { gradient?: string }): CardDesign {
  if (custom?.gradient) {
    const g = CARD_GRADIENTS.find((x) => x.id === custom.gradient);
    if (g) return { from: g.from, to: g.to, combo: g.combo };
  }
  return SPECIAL_DESIGNS[currencyKey] ?? GENERIC_DESIGN;
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
        overflow: 'hidden',
        color: c.text,
        userSelect: 'none',
        boxShadow: '0 8px 24px rgba(0,0,0,.25)',
      }}
    >
      {design.bg && <img src={`./cake/new-ui/balance_card_backgrounds/${design.bg}`} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />}
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
