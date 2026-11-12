// QR codes (qr_flutter in Cake): black on white, error correction H, with the
// chain badge in the middle (lib/utils/qr_util.dart).

import { encode } from 'uqr';
import { useMemo } from 'preact/hooks';
import type { WalletType } from '../../coins/types.ts';

const BADGES: Partial<Record<WalletType, string>> = {
  bitcoin: 'btc_chain_qr.svg', monero: 'xmr_chain_qr.svg', ethereum: 'eth_chain_qr.svg', litecoin: 'ltc_chain_qr.svg', solana: 'sol_chain_qr.svg', tron: 'trx_chain_qr.svg',
  polygon: 'pol_chain_qr.svg', bitcoinCash: 'bch_chain_qr.svg', dogecoin: 'doge_chain_qr.svg', nano: 'xno_chain_qr.svg', decred: 'dcr_chain_qr.svg', zano: 'zano_chain_qr.svg',
  wownero: 'wow_chain_qr.svg', zcash: 'zec_icon_qr.svg', base: 'base_chain_QR.svg', arbitrum: 'arbitrum_chain_QR.svg', bsc: 'bnb_chain_QR.svg', robinhood: 'robinhood_chain_QR.svg',
};

export function qrBadge(type?: WalletType, lightning = false): string {
  if (lightning) return './cake/images/btc_chain_qr_lightning.svg';
  const b = type && BADGES[type];
  return b ? `./cake/images/${b}` : './cake/images/qr-cake.png';
}

export function QrCode({ data, size = 220, logo, id }: { data: string; size?: number; logo?: string; id?: string }) {
  const qr = useMemo(() => encode(data || ' ', { ecc: 'H', border: 0 }), [data]);
  const n = qr.size;
  const rects: string[] = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (qr.data[y][x]) {
        let w = 1;
        while (x + w < n && qr.data[y][x + w]) w++;
        rects.push(`M${x} ${y}h${w}v1h-${w}z`);
        x += w;
      } else x++;
    }
  }
  const logoSize = n * 0.24;
  return (
    <div id={id} data-qr={data} style={{ background: '#fff', borderRadius: '20px', padding: '12px', width: `${size}px`, height: `${size}px`, position: 'relative', flex: 'none' }}>
      <svg viewBox={`0 0 ${n} ${n}`} width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="QR code">
        <path d={rects.join('')} fill="#000" />
      </svg>
      {logo && <img src={logo} alt="" style={{ position: 'absolute', left: '50%', top: '50%', width: `${(logoSize / n) * (size - 24)}px`, height: `${(logoSize / n) * (size - 24)}px`, transform: 'translate(-50%, -50%)', background: '#fff', borderRadius: '8px', padding: '2px' }} />}
    </div>
  );
}
