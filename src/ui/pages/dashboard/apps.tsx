// Apps tab (lib/src/screens/dashboard/pages/cake_features_page.dart).

import { t } from '../../../core/i18n.ts';
import { Img, MIcon } from '../../components/core.tsx';
import { currentWallet } from '../../../app/app.ts';
import { nav } from '../../nav.ts';
import { Routes } from '../../routes.ts';
import { openExternal } from './history.tsx';

function AppCard({ image, title, subtitle, cake, external, onClick, id }: { image: string; title: string; subtitle: string; cake?: boolean; external?: boolean; onClick: () => void; id?: string }) {
  return (
    <button type="button" id={id} onClick={onClick} class="rowx" style={{ width: '100%', gap: '20px', margin: '5px 0', padding: '24px', borderRadius: '18px', border: '1.25px solid var(--surface-container-high)', background: 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))', cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start' }}>
      <Img src={image} size={54} />
      <span class="grow col" style={{ gap: '5px' }}>
        <span class="rowx gap8">
          <span style={{ fontSize: '20px', fontWeight: 800 }}>{title}</span>
          {cake && <img src="./cake/new-ui/cakelabs-icon.svg" alt="" style={{ height: '16px', opacity: 0.6 }} />}
        </span>
        <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--on-surface-variant)' }}>{subtitle}</span>
      </span>
      {external ? <MIcon name="arrowUp" size={20} color="var(--on-surface-variant)" style={{ transform: 'rotate(45deg)' }} /> : <MIcon name="chevronRight" size={20} color="var(--on-surface-variant)" />}
    </button>
  );
}

export function CakeFeaturesPage() {
  const isEth = currentWallet.value?.type === 'ethereum';
  return (
    <div class="page legacy" id="apps_page">
      <div style={{ textAlign: 'center', fontSize: '18px', fontWeight: 600, padding: '24px 0' }}>{t('apps')}</div>
      <div class="page-body" style={{ padding: '0 20px 140px' }}>
        <img src="./cake/new-ui/by-cakelabs.svg" alt="by Cake Labs" style={{ height: '20px', margin: '0 4px 8px', opacity: 0.6 }} />
        <AppCard id="app_cake_pay" image="assets/images/cakepay.png" title="Cake Pay" subtitle={t('cake_pay_subtitle')} cake onClick={() => nav.push(Routes.cakePayCardsPage)} />
        <AppCard image="assets/images/cupcake.png" title="Cupcake" subtitle="Turn your old phone into your new hardware wallet with our new app" cake external onClick={() => openExternal('https://cupcakewallet.com')} />
        <AppCard image="assets/images/radar.png" title="Radar" subtitle="Your messages. Your Bitcoin. Together, at last" cake external onClick={() => openExternal('https://radar.chat')} />
        <div style={{ fontSize: '18px', fontWeight: 500, padding: '28px 4px 8px' }}>Featured Apps</div>
        <AppCard image="assets/images/nanogpt.png" title="NanoGPT" subtitle={t('nanogpt_subtitle')} external onClick={() => openExternal('https://cake.nano-gpt.com')} />
        <AppCard image="assets/images/btcmap.png" title="BTC Map" subtitle={t('btcmap_subtitle')} external onClick={() => openExternal('https://btcmap.org/apps')} />
        {isEth && <AppCard image="assets/images/deuro_icon.png" title={t('deuro_savings')} subtitle={t('deuro_savings_subtitle')} onClick={() => nav.push(Routes.dEuroSavings)} />}
      </div>
    </div>
  );
}
