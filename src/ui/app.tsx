// App shell: renders the page stack (top page visible, previous kept mounted
// underneath for instant back navigation) plus sheets/alerts/toasts.

import { useEffect } from 'preact/hooks';
import { stack, nav } from './nav.ts';
import { isKeepAlive, routeComponent, Routes } from './routes.ts';
import { Overlays } from './components/overlays.tsx';
import { LongPressPopups } from './components/longPress.tsx';
import { phase, walletInfos } from '../app/app.ts';
import { WELCOME_PAGE } from './pages/onboarding.tsx';
import { language } from '../core/i18n.ts';
import { Spinner } from './components/core.tsx';

export function App() {
  // re-render on language change
  void language.value;
  const p = phase.value;

  useEffect(() => {
    if (p === 'welcome') nav.reset(Routes.welcome);
    else if (p === 'locked') nav.reset(Routes.login);
    else if (p === 'ready' && (!nav.top || nav.top.name === Routes.login || nav.top.name === Routes.welcome)) nav.reset(walletInfos.value.length ? Routes.dashboard : WELCOME_PAGE);
  }, [p]);

  if (p === 'boot') {
    return (
      <div class="page solid" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <img src="./cake/images/cakewallet_logo.png" alt="Cake Wallet" style={{ width: '120px', height: '120px', borderRadius: '28px' }} />
        <div style={{ marginTop: '24px' }}>
          <Spinner />
        </div>
      </div>
    );
  }

  const entries = stack.value;
  // the top two, plus pages that keep their state while covered (the swap and its sub-pages)
  const visible = entries.filter((r, i) => i >= entries.length - 2 || isKeepAlive(r.name));
  return (
    <>
      {visible.map((r, i) => {
        const C = routeComponent(r.name);
        const top = i === visible.length - 1;
        return (
          <div key={r.key} class={top ? 'page-enter' : ''} style={{ position: 'absolute', inset: 0, visibility: top ? 'visible' : 'hidden' }} aria-hidden={!top}>
            {C ? <C args={r.args} /> : <Missing name={r.name} />}
          </div>
        );
      })}
      <Overlays />
      <LongPressPopups />
    </>
  );
}

function Missing({ name }: { name: string }) {
  return (
    <div class="page">
      <div class="page-body pad" style={{ paddingTop: '80px' }}>
        <p class="center muted">Unknown page {name}</p>
        <button class="btn secondary" onClick={() => nav.pop()}>
          Back
        </button>
      </div>
    </div>
  );
}
