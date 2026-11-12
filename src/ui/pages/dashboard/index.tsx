// NewDashboard + NewMainNavBar (lib/new-ui/new_dashboard.dart,
// lib/src/screens/dashboard/widgets/new_main_navbar_widget.dart).

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Icon } from '../../components/core.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { settings } from '../../../app/settings.ts';
import { currentWallet } from '../../../app/app.ts';
import { HomePage } from './home.tsx';
import { WalletListPage } from './wallets.tsx';
import { ContactListPage } from './contacts.tsx';
import { CakeFeaturesPage } from './apps.tsx';
import { ChartsPage } from './charts.tsx';

export const dashboardTab = signal(0);

const ITEMS = [
  { key: 'home', icon: 'navbar/home.svg' },
  { key: 'wallets', icon: 'navbar/wallets.svg' },
  { key: 'contacts', icon: 'navbar/contacts.svg' },
  { key: 'apps', icon: 'navbar/apps.svg' },
  { key: 'charts', icon: 'navbar/charts.svg' },
];

function NavBar() {
  const sel = dashboardTab.value;
  const items = ITEMS.map((it, i) => ({ ...it, i })).filter((it) => it.key !== 'apps' || settings.value.shouldShowMarketPlaceInDashboard);
  return (
    <nav
      id="main_nav_bar"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: '12px',
        transform: 'translateX(-50%)',
        height: '68px',
        borderRadius: '50px',
        background: 'color-mix(in srgb, var(--surface-container) 50%, transparent)',
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
        border: '1px solid rgba(255,255,255,.08)',
        padding: '0 6px',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        zIndex: 20,
      }}
    >
      {items.map((it) => {
        const on = it.i === sel;
        return (
          <button
            type="button"
            aria-label={t(it.key)}
            id={`nav_${it.key}`}
            onClick={() => (dashboardTab.value = it.i)}
            style={{
              height: '56px',
              minWidth: '48px',
              padding: on ? '0 20px 0 12px' : 0,
              borderRadius: '50px',
              border: 0,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              background: on ? 'color-mix(in srgb, var(--on-surface) 10%, transparent)' : 'none',
              color: on ? 'var(--on-surface)' : 'var(--primary)',
              transition: 'background 250ms, padding 250ms',
            }}
          >
            <Icon src={it.icon} size={on ? 24 : 28} />
            {on && <span style={{ fontSize: '16px', fontWeight: 500 }}>{t(it.key)}</span>}
          </button>
        );
      })}
    </nav>
  );
}

function NewDashboard() {
  const sel = dashboardTab.value;
  // switching the active wallet resets to the Home tab
  const id = currentWallet.value?.id;
  useEffect(() => {
    dashboardTab.value = 0;
  }, [id]);
  const pages = [HomePage, WalletListPage, ContactListPage, CakeFeaturesPage, ChartsPage];
  return (
    <div class="page" id="dashboard">
      {pages.map((P, i) => (
        <div style={{ position: 'absolute', inset: 0, display: i === sel ? 'block' : 'none' }}>
          <P />
        </div>
      ))}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '150px', pointerEvents: 'none', background: 'linear-gradient(to bottom, color-mix(in srgb, var(--surface-dim) 2%, transparent), color-mix(in srgb, var(--surface-dim) 78%, transparent))' }} />
      <NavBar />
    </div>
  );
}

registerRoute(Routes.dashboard, NewDashboard);
