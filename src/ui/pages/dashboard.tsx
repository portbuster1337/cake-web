// Placeholder dashboard; replaced by the full new-UI dashboard (dashboard/*.tsx).
import { registerRoute, Routes } from '../routes.ts';
import { Page } from '../components/core.tsx';
import { currentWallet } from '../../app/app.ts';

function Dashboard() {
  const w = currentWallet.value;
  return (
    <Page title={w?.name ?? 'Cake Wallet'} noBack>
      <p class="muted">{w ? w.type : 'No wallet'}</p>
    </Page>
  );
}

registerRoute(Routes.dashboard, Dashboard);
