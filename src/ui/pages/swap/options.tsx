// Swap configuration (lib/new-ui/widgets/swap_page/swap_options_page.dart), the
// provider whitelist (provider_options_page.dart), the provider chooser
// (provider_selector_page.dart), the legacy "Change Swap Provider" check list
// (PresentProviderPicker) and Trocador's partners (trocador_providers_settings.dart).

import { useEffect, useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Button, Check, Img, Page, Row, Section, Spinner, ToggleRow } from '../../components/core.tsx';
import { showAlert } from '../../components/overlays.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { settings, updateSettings } from '../../../app/settings.ts';
import { pickFiat } from '../settings/pages.tsx';
import type { ExchangeVM } from '../../../exchange/exchange.ts';
import type { ExchangeProvider } from '../../../exchange/types.ts';
import { trocadorPartners, type TrocadorPartner } from '../../../exchange/providers/trocador.ts';
import { apiKey } from '../../../exchange/keys.ts';
import { askRefundAddress } from './swap.tsx';

/** the provider row's subtitle: Trocador's partners, or the API key this build lacks */
function keyNote(p: ExchangeProvider): string | undefined {
  return p.needsApiKey && !apiKey(p.needsApiKey) ? 'API key needed (Settings → Connection and sync → API keys)' : undefined;
}

function SwapOptionsPage({ args }: { args: { vm: ExchangeVM } }) {
  const vm = args.vm;
  return (
    <Page title={t('configure')} solid id="swap_options_page">
      <div class="col" style={{ gap: '24px', paddingTop: '8px' }}>
        <div class="col">
          <span style={{ fontSize: '14px', fontWeight: 500 }}>{t('current_swap')}</span>
          <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--primary)' }} id="swap_current_pair">{`${vm.depositCurrency.value.title} → ${vm.receiveCurrency.value.title}`}</span>
        </div>
        <Section>
          <ToggleRow label={t('fixed_rate')} value={vm.isFixedRateMode.value} id="swap_fixed_rate" onChange={(v) => (v ? vm.enableFixedRateMode() : vm.disableFixedRateMode())} />
          <Row label={t('set_refund_address')} id="swap_set_refund" onClick={async () => {
            const r = await askRefundAddress(vm.depositCurrency.value, false);
            if (r !== undefined) vm.depositAddress.value = r;
          }} />
        </Section>
        <Section header={t('general')}>
          <Row label={t('swap_providers')} id="swap_providers_row" onClick={() => nav.push(Routes.swapProvidersPage, { vm })} />
          <Row label="Coin Control" id="swap_coin_control" onClick={() => nav.push(Routes.unspentCoinsList, { canEdit: true })} />
          <Row label={t('change_fiat_currency')} trailingText={settings.value.fiatCurrency} id="swap_fiat" onClick={() => void pickFiat()} />
        </Section>
      </div>
    </Page>
  );
}

function ProviderOptionsPage({ args }: { args: { vm: ExchangeVM } }) {
  const vm = args.vm;
  const list = vm.providerList();
  const selected = vm.selectedProviders.value;
  const decentralizedOnly = vm.forceDecentralized;
  const decentralized = list.filter((p) => !p.description.isCentralized);
  const centralized = list.filter((p) => p.description.isCentralized);
  // each change: the region check, add/remove, saveSelectedProviders
  const toggle = async (p: ExchangeProvider, on: boolean) => {
    if (!p.isAvailable) {
      await showAlert({ title: t('error'), content: 'The exchange is blocked in your region.', right: t('ok') });
      return;
    }
    if (on) vm.addExchangeProvider(p);
    else vm.removeExchangeProvider(p);
    vm.saveSelectedProviders();
  };
  const setAll = (group: ExchangeProvider[], on: boolean) => {
    for (const p of group) {
      if (!p.isAvailable) continue;
      if (on) vm.addExchangeProvider(p);
      else vm.removeExchangeProvider(p);
    }
    vm.saveSelectedProviders();
  };
  const group = (title: string, items: ExchangeProvider[], dim: boolean, id: string) => (
    <div class="col" style={{ gap: '8px', position: 'relative' }} id={id}>
      <div class="rowx" style={{ justifyContent: 'space-between', padding: '0 4px' }}>
        <span style={{ color: 'var(--on-surface-variant)' }}>{title}</span>
        <span class="rowx" style={{ gap: '16px' }}>
          <button type="button" onClick={() => setAll(items, true)} style={{ border: 0, background: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}>{t('select_all')}</button>
          <button type="button" onClick={() => setAll(items, false)} style={{ border: 0, background: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}>{t('unselect_all')}</button>
        </span>
      </div>
      <div class="list">
        {items.map((p) => {
          const on = selected.includes(p);
          const trocadorRow = p.title === 'Trocador';
          return (
            <div class="row tap has-icon" id={`swap_provider_${p.title.replace(/[^A-Za-z]/g, '')}`} onClick={() => (trocadorRow ? nav.push(Routes.trocadorProviders) : void toggle(p, !on))}>
              <Img src={p.description.image} size={26} />
              <span class="lbl">
                <span>{p.title}</span>
                {(trocadorRow || keyNote(p)) && <span class="sub">{[trocadorRow ? t('manage_providers') : '', keyNote(p) ?? ''].filter(Boolean).join(' · ')}</span>}
              </span>
              <Check on={on} onChange={(v) => void toggle(p, v)} />
            </div>
          );
        })}
      </div>
      {dim && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.25)', borderRadius: '16px' }} onClick={(e) => e.stopPropagation()} />}
    </div>
  );
  return (
    <Page title={t('swap_providers')} solid id="swap_providers_page">
      <div class="col" style={{ gap: '24px', paddingTop: '8px' }}>
        <Section>
          <Row label={t('preference')} trailingText={decentralizedOnly ? t('decentralized_only') : t('best_rate')} id="swap_preference" onClick={() => vm.toggleForceDecentralized()} />
        </Section>
        {group(t('decentralized'), decentralized, false, 'swap_group_decentralized')}
        {group(t('centralized'), centralized, decentralizedOnly, 'swap_group_centralized')}
      </div>
    </Page>
  );
}

/** ProviderSelectorPage: the best rate (no forced provider) or one of the selected providers */
function ProviderSelectorPage({ args }: { args: { vm: ExchangeVM } }) {
  const vm = args.vm;
  const best = vm.bestRateProvider.value;
  const forced = vm.forcedProvider.value;
  const selected = vm.selectedProviders.value;
  const pick = (p: ExchangeProvider | null) => {
    vm.setForcedProvider(p);
    nav.pop();
  };
  const row = (p: ExchangeProvider, checked: boolean, onClick: () => void, subtitle?: string) => (
    <div class="row tap has-icon" id={`swap_select_${p.title.replace(/[^A-Za-z]/g, '')}`} onClick={onClick}>
      <Img src={p.description.image} size={26} />
      <span class="lbl">
        <span>{p.title}</span>
        {subtitle && <span class="sub">{subtitle}</span>}
      </span>
      <Check on={checked} />
    </div>
  );
  const dec = selected.filter((p) => !p.description.isCentralized);
  const cen = selected.filter((p) => p.description.isCentralized);
  return (
    <Page title={t('change_provider')} solid id="swap_provider_selector">
      <div class="col" style={{ gap: '24px', paddingTop: '8px' }}>
        <div class="muted center" style={{ whiteSpace: 'pre-line' }}>{`${t('change_provider_desc_1')}\n${t('change_provider_desc_2')}`}</div>
        {best && <Section header={t('best_rate')}>{row(best, forced === null, () => pick(null), best.description.isCentralized ? t('centralized') : t('decentralized'))}</Section>}
        {dec.length > 0 && <Section header={t('decentralized')}>{dec.map((p) => row(p, forced === p, () => pick(p)))}</Section>}
        {cen.length > 0 && <Section header={t('centralized')}>{cen.map((p) => row(p, forced === p, () => pick(p)))}</Section>}
      </div>
    </Page>
  );
}

/** PresentProviderPicker ("Change Swap Provider"): saved on close */
function ProviderPickerPage({ args }: { args: { vm: ExchangeVM } }) {
  const vm = args.vm;
  useEffect(() => () => vm.saveSelectedProviders(), []);
  const selected = vm.selectedProviders.value;
  return (
    <Page title={t('change_exchange_provider')} solid id="swap_provider_picker">
      <Section>
        {vm.providerList().map((p) => {
          const on = selected.includes(p);
          return (
            <div class="row tap has-icon" onClick={async () => {
              if (!p.isAvailable) {
                await showAlert({ title: t('error'), content: 'The exchange is blocked in your region.', right: t('ok') });
                return;
              }
              if (on) vm.removeExchangeProvider(p);
              else vm.addExchangeProvider(p);
            }}>
              <Img src={p.description.image} size={26} />
              <span class="lbl"><span>{p.title}</span>{keyNote(p) && <span class="sub">{keyNote(p)}</span>}</span>
              <Check on={on} />
            </div>
          );
        })}
      </Section>
    </Page>
  );
}

/** TrocadorProvidersSettings: one switch per partner, with its KYC rating */
function TrocadorProvidersPage() {
  const [list, setList] = useState<TrocadorPartner[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!apiKey('trocador')) {
      setList([]);
      setError('API key needed (Settings → Connection and sync → API keys)');
      return;
    }
    trocadorPartners()
      .then((p) => {
        const old = settings.peek().trocadorProviderStates ?? {};
        const next: Record<string, boolean> = {};
        for (const x of p) next[x.name] = old[x.name] ?? true;
        updateSettings({ trocadorProviderStates: next });
        setList(p);
      })
      .catch((e) => {
        setList([]);
        setError((e as Error).message);
      });
  }, []);
  const states = settings.value.trocadorProviderStates ?? {};
  return (
    <Page title="Trocador Providers" solid id="trocador_providers_page">
      <div class="col" style={{ gap: '16px', paddingTop: '8px' }}>
        <div class="col" style={{ gap: '4px' }}>
          <span style={{ fontWeight: 500 }}>{`${t('about')} Trocador`}</span>
          <span class="muted">{`Trocador ${t('trocador_desc')}`}</span>
        </div>
        <span style={{ fontWeight: 500 }}>{t('providers')}</span>
        <span class="muted">{t('trocador_desc_kyc')}</span>
        {list === null ? (
          <div class="center"><Spinner /></div>
        ) : list.length === 0 ? (
          <div class="muted center">{error || t('no_providers_available')}</div>
        ) : (
          <Section>
            {list.map((p) => (
              <ToggleRow
                label={
                  <span class="rowx" style={{ gap: '8px' }}>
                    <span style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--surface-container-high)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700 }}>{p.rating}</span>
                    {p.name}
                  </span>
                }
                value={states[p.name] !== false}
                onChange={(v) => updateSettings({ trocadorProviderStates: { ...(settings.peek().trocadorProviderStates ?? {}), [p.name]: v } })}
              />
            ))}
          </Section>
        )}
        <Button secondary onClick={() => nav.pop()}>{t('ok')}</Button>
      </div>
    </Page>
  );
}

registerRoute(Routes.swapOptions, SwapOptionsPage);
registerRoute(Routes.swapProvidersPage, ProviderOptionsPage);
registerRoute(Routes.swapProviderSelector, ProviderSelectorPage);
registerRoute(Routes.swapProviderPicker, ProviderPickerPage);
registerRoute(Routes.trocadorProviders, TrocadorProvidersPage);
