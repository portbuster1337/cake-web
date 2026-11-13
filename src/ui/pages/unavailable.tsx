// Pages whose feature this web client cannot offer yet, laid out as Cake's so
// the entry points are not dead ends: the hardware wallet manufacturers
// (lib/src/screens/connect_device/select_device_manufacturer_page.dart) and the
// WalletConnect connections (lib/src/screens/wallet_connect/wc_connections_listing_view.dart).

import { t } from '../../core/i18n.ts';
import { Button, Icon, Img, Page } from '../components/core.tsx';
import { showAlert, toast } from '../components/overlays.tsx';
import { registerRoute, Routes } from '../routes.ts';

const DEVICES = [
  { id: 'ledger', image: 'assets/images/hardware_wallet/ledger_man.svg' },
  { id: 'trezor', image: 'assets/images/hardware_wallet/trezor_man.svg' },
  { id: 'coldcard', image: 'assets/images/hardware_wallet/coldcard_man.svg' },
];
const COMING = ['seedsigner', 'foundation', 'keystone'];

function ManufacturerTile({ image, tag, unavailable, onClick, id }: { image: string; tag?: string; unavailable?: boolean; onClick: () => void; id: string }) {
  return (
    <button type="button" id={id} onClick={onClick} class="rowx" style={{ width: '100%', height: '66px', marginTop: '10px', padding: '0 20px', borderRadius: '12px', border: 0, background: 'var(--surface-container)', cursor: 'pointer', justifyContent: 'space-between', opacity: unavailable ? 0.5 : 1 }}>
      <Icon src={image} h={25} w={120} color="var(--on-surface)" />
      {tag && <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--on-primary)', background: 'var(--primary)', borderRadius: '999px', padding: '4px 10px' }}>{tag}</span>}
    </button>
  );
}

/** SelectDeviceManufacturerPage (args.showUnavailable: also the coming ones) */
function HardwareWalletPage({ args }: { args?: { showUnavailable?: boolean } }) {
  const unsupported = () => void showAlert({ title: t('select_manufacturer_title'), content: 'Hardware wallets connect over USB, Bluetooth or QR codes with the device. This web client does not support them yet; restore from a seed or keys, or use the Cake Wallet app.', right: t('ok') });
  return (
    <Page title={t('select_manufacturer_title')} legacy id="select_manufacturer_page">
      <div style={{ padding: '0 6px 24px' }}>
        {DEVICES.map((d) => <ManufacturerTile id={`hw_${d.id}`} image={d.image} onClick={unsupported} />)}
        {args?.showUnavailable && (
          <>
            <div style={{ borderTop: '2px dotted var(--surface-container)', margin: '20px 0 10px' }} />
            {COMING.map((c) => <ManufacturerTile id={`hw_${c}`} image={`assets/images/hardware_wallet/${c}_man.svg`} tag={t('coming_soon_tag')} unavailable onClick={() => toast('One more tap and it might work')} />)}
          </>
        )}
      </div>
    </Page>
  );
}

/** WalletConnectConnectionsView */
function WalletConnectPage() {
  const unsupported = () => void showAlert({ title: 'WalletConnect', content: 'WalletConnect talks to its relay over a WebSocket, which cannot go through this client\'s Tor connection yet, so dApps cannot be connected for now.', right: t('ok') });
  return (
    <Page title="WalletConnect" solid id="wallet_connect_page" footer={<div class="col" style={{ gap: '12px' }}><Button id="wc_paste_link" onClick={unsupported}>{t('wc_paste_link')}</Button><Button secondary id="wc_scan_qr" onClick={unsupported}>{t('wc_scan_qr')}</Button></div>}>
      <div class="col" style={{ alignItems: 'center', gap: '16px', paddingTop: '30%' }}>
        <Img src="assets/new-ui/walletconnect_icon.svg" size={56} />
        <div class="center muted" id="wc_empty">{t('activeConnectionsPrompt')}</div>
      </div>
    </Page>
  );
}

registerRoute(Routes.restoreWalletFromHardwareWallet, HardwareWalletPage);
registerRoute(Routes.walletConnectConnectionsListing, WalletConnectPage);
