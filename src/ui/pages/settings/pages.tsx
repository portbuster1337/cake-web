// Security, Privacy, Display, Other, Support, About, Recovery & Keys
// (lib/src/screens/settings/*, lib/new-ui/pages/about_page.dart,
// lib/new-ui/pages/seed/show_keys_disclaimer_page.dart, lib/src/screens/wallet_keys/*).

import { useEffect, useState } from 'preact/hooks';
import { t, SUPPORTED_LOCALES, LOCALE_COUNTRY, setLanguage, language } from '../../../core/i18n.ts';
import { Button, Img, MIcon, Page, Row, Section, Sections, Segmented, ToggleRow, TopBar, copyText } from '../../components/core.tsx';
import { confirmAlert, showAlert, showSheet, toast } from '../../components/overlays.tsx';
import { requireAuth } from '../../components/auth.tsx';
import { QrCode } from '../../components/qr.tsx';
import { registerRoute, routeComponent, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { ModalHeader } from './main.tsx';
import { pickOption } from '../newWallet.tsx';
import { settings, updateSettings } from '../../../app/settings.ts';
import { currentWallet, getSecrets } from '../../../app/app.ts';
import { vault } from '../../../core/vault.ts';
import { applyTheme, BLACK_ACCENTS, THEMES, resolveTheme, themeRaw } from '../../theme/themes.ts';
import { FIAT_CURRENCIES, FIAT_FLAG, resetPrices } from '../../../app/prices.ts';
import { WALLET_TYPE_NAME } from '../../../coins/types.ts';
import { openExternal } from '../dashboard/history.tsx';
import type { WalletKeysRow } from '../../../core/wallet.ts';

// ------------------------------------------------------------- security --

const PIN_DURATIONS = [0, 10, 30, 45, 60];

function SecurityPage() {
  const s = settings.value;
  const [duress, setDuress] = useState(false);
  useEffect(() => void vault.hasDuressPin().then(setDuress), []);
  const sb = { totp: s.shouldRequireTOTP2FAForAllSecurityAndBackupSettings };
  return (
    <Page title={t('security')} solid id="security_page">
      <ModalHeader icon="assets/new-ui/settings_row_icons/security.svg" title={t('security')} message={t('privacy_and_security_desc')} />
      <Section>
        <ToggleRow
          label="Duress PIN"
          value={duress}
          id="security_duress"
          onChange={async (v) => {
            if (!(await requireAuth({ always: true, ...sb }))) return;
            if (!v) {
              await vault.setDuressPin(null);
              updateSettings({ enableDuressPin: false });
              setDuress(false);
              return;
            }
            await showAlert({ title: t('alert_notice'), content: t('duress_pin_description') });
            if (!(await confirmAlert(t('confirm'), t('did_you_back_up_seeds'), t('yes'), t('no')))) return;
            nav.push(Routes.setupDuressPin, {
              isDuress: true,
              onPin: async (pin: string) => {
                await vault.setDuressPin(pin);
                updateSettings({ enableDuressPin: true });
              },
              onSuccess: () => {
                setDuress(true);
                nav.pop();
              },
            });
          }}
        />
        <Row label={t('require_pin_after')} trailingText={s.pinTimeOutDuration === 0 ? t('always') : t('minutes_to_pin_code', { minute: s.pinTimeOutDuration })} id="security_require_pin" onClick={async () => {
          const v = await pickOption(t('require_pin_after'), PIN_DURATIONS.map((m) => ({ id: String(m), label: m === 0 ? t('always') : t('minutes_to_pin_code', { minute: m }) })), String(s.pinTimeOutDuration));
          if (v !== undefined) updateSettings({ pinTimeOutDuration: Number(v) });
        }} />
        <Row label={t('settings_change_pin')} id="security_change_pin" onClick={async () => {
          if (!(await requireAuth({ always: true, ...sb }))) return;
          nav.push(Routes.setupPin, {
            onPin: async (pin: string) => {
              await vault.changePin(pin);
              updateSettings({ pinLength: pin.length as 4 | 6 });
              const { db } = await import('../../../core/db.ts');
              await db.put('kv', 'pinLength', pin.length);
            },
            onSuccess: () => nav.pop(),
          });
        }} />
        <Row label={s.useTOTP2FA ? t('modify_2fa') : t('setup_2fa')} id="security_2fa" onClick={async () => {
          if (s.useTOTP2FA) {
            if (await requireAuth({ always: true, ...sb })) nav.push(Routes.modify2FAPage);
          } else if (await requireAuth({ ...sb })) nav.push(Routes.setup2faInfoPage);
        }} />
      </Section>
    </Page>
  );
}

// -------------------------------------------------------------- privacy --

function PrivacyPage() {
  const s = settings.value;
  const w = currentWallet.value;
  const autoTypes = ['monero', 'wownero', 'bitcoin', 'litecoin', 'bitcoinCash', 'dogecoin', 'decred'];
  return (
    <Page title={t('privacy')} solid id="privacy_page">
      <ModalHeader icon="assets/new-ui/settings_row_icons/privacy.svg" title={t('privacy')} message={t('privacy_desc')} />
      <Section>
        {w && autoTypes.includes(w.type) && (
          <ToggleRow label={w.type === 'monero' ? t('auto_generate_subaddresses') : t('auto_generate_addresses')} value={s.autoGenerateSubaddressStatus !== 'disabled'} id="privacy_autogenerate" onChange={(v) => updateSettings({ autoGenerateSubaddressStatus: v ? 'enabled' : 'disabled' })} />
        )}
        <ToggleRow label={t('settings_save_recipient_address')} value={s.shouldSaveRecipientAddress} onChange={(v) => updateSettings({ shouldSaveRecipientAddress: v })} />
      </Section>
    </Page>
  );
}

// -------------------------------------------------------------- display --

function DisplayPage() {
  const s = settings.value;
  const th = resolveTheme(themeRaw.value);
  const mode: 'system' | 'light' | 'dark' = themeRaw.value === null ? 'system' : th.palette.isDark ? 'dark' : 'light';
  const isBlack = th.id.startsWith('black');
  const accent = isBlack ? th.id.replace(/^black-/, '').replace(/-oled$/, '') : null;
  const oled = th.id.endsWith('-oled');
  const setTheme = (raw: number | null) => {
    applyTheme(raw);
    updateSettings({ themeRaw: raw });
  };
  const btcDisplay = ['sats (LN)', 'BTC', 'sats'];
  return (
    <Page title={t('display')} solid id="display_page">
      <div class="col gap8">
        <div class="muted">{t('appearance')}</div>
        <div style={{ background: 'var(--surface-container-high)', borderRadius: '18px', padding: '12px' }} class="col gap12">
          <Segmented options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} value={mode} onChange={(v) => setTheme(v === 'system' ? null : v === 'light' ? 0 : 1)} />
          <div style={{ background: 'var(--surface-container)', borderRadius: '18px', padding: '12px' }} class="col gap12">
            <div class="rowx gap12 scroll-x">
              {(mode === 'light' ? [THEMES[0]] : [THEMES[1], THEMES.find((x) => x.raw === 12)!]).map((x) => {
                const sel = x.id === th.id || (x.raw === 12 && isBlack);
                return (
                  <button type="button" onClick={() => setTheme(x.raw)} id={`theme_${x.id}`} style={{ border: sel ? '2px solid var(--primary)' : '2px solid transparent', borderRadius: '18px', padding: 0, background: 'none', cursor: 'pointer' }}>
                    <img src={`./cake/new-ui/${x.raw === 0 ? 'light' : x.raw === 1 ? 'dark' : 'black_accent'}.svg`} alt={x.title} style={{ height: '160px', width: '96px', objectFit: 'cover', borderRadius: '16px', display: 'block' }} />
                  </button>
                );
              })}
            </div>
            {isBlack && (
              <>
                <div>{t('accent_color')}</div>
                <div class="rowx gap12">
                  {Object.entries(BLACK_ACCENTS).map(([k, a], i) => (
                    <button type="button" aria-label={a.name} onClick={() => setTheme((oled ? 112 : 12) + i)} style={{ width: '28px', height: '28px', borderRadius: '50%', background: a.color, border: accent === k ? '2px solid var(--on-surface)' : 0, cursor: 'pointer' }} />
                  ))}
                </div>
                <ToggleRow label={t('oled_mode')} value={oled} onChange={(v) => setTheme((v ? 112 : 12) + Math.max(0, Object.keys(BLACK_ACCENTS).indexOf(accent ?? 'cakePrimary')))} />
              </>
            )}
          </div>
        </div>
        <div style={{ height: '16px' }} />
        <Section>
          <ToggleRow label={t('apps')} value={s.shouldShowMarketPlaceInDashboard} onChange={(v) => updateSettings({ shouldShowMarketPlaceInDashboard: v })} />
          <ToggleRow label={t('show_address_book_popup')} value={s.showAddressBookPopupEnabled} onChange={(v) => updateSettings({ showAddressBookPopupEnabled: v })} />
          <ToggleRow label={t('disable_buy')} value={s.disableTradeOption} onChange={(v) => updateSettings({ disableTradeOption: v })} />
          <Row label={t('sync_status_display_mode')} trailingText={s.syncStatusDisplayMode === 'eta' ? 'ETA' : 'Blocks Remaining'} onClick={async () => {
            const v = await pickOption(t('sync_status_display_mode'), [{ id: 'eta', label: 'ETA' }, { id: 'blocksRemaining', label: 'Blocks Remaining' }], s.syncStatusDisplayMode);
            if (v) updateSettings({ syncStatusDisplayMode: v as any });
          }} />
          {currentWallet.value?.type === 'bitcoin' && (
            <Row label={t('bitcoin_amount_display')} trailingText={btcDisplay[s.bitcoinAmountDisplay]} onClick={async () => {
              const v = await pickOption(t('bitcoin_amount_display'), [{ id: '2', label: 'sats' }, { id: '0', label: 'sats (LN)' }, { id: '1', label: 'BTC' }], String(s.bitcoinAmountDisplay));
              if (v !== undefined) updateSettings({ bitcoinAmountDisplay: Number(v) as 0 | 1 | 2, displayAmountsInSatoshi: v === '2' });
            }} />
          )}
          {s.fiatApiMode !== 'disabled' && <Row label={t('settings_currency')} trailingText={s.fiatCurrency} id="display_currency" onClick={() => void pickFiat()} />}
          <Row label={t('settings_change_language')} trailingText={SUPPORTED_LOCALES[language.value]?.split(' ')[0]} id="display_language" onClick={() => void pickLanguage()} />
        </Section>
      </div>
    </Page>
  );
}

export const FIAT_NAMES: Record<string, string> = {
  AMD: 'Armenian Dram', ARS: 'Argentine Peso', AUD: 'Australian Dollar', BDT: 'Bangladeshi Taka', BGN: 'Bulgarian Lev', BRL: 'Brazilian Real', CAD: 'Canadian Dollar', CHF: 'Swiss Franc', CLP: 'Chilean Peso', CNY: 'Chinese Yuan',
  COP: 'Colombian Peso', CZK: 'Czech Koruna', DKK: 'Danish Krone', EGP: 'Egyptian Pound', EUR: 'Euro', GBP: 'Pound Sterling', GHS: 'Ghanaian Cedi', GTQ: 'Guatemalan Quetzal', HKD: 'Hong Kong Dollar', HRK: 'Croatian Kuna',
  HUF: 'Hungarian Forint', IDR: 'Indonesian Rupiah', ILS: 'Israeli New Shekel', INR: 'Indian Rupee', IRR: 'Iranian Rial', ISK: 'Icelandic Krona Króna', JPY: 'Japanese Yen', KRW: 'South Korean Won', MAD: 'Moroccan Dirham',
  MXN: 'Mexican Peso', MYR: 'Malaysian Ringgit', NGN: 'Nigerian Naira', NOK: 'Norwegian Krone', NZD: 'New Zealand Dollar', PHP: 'Philippine Peso', PKR: 'Pakistani Rupee', PLN: 'Poland Zloty złoty', RON: 'Romanian Leu',
  RUB: 'Russian Ruble', SAR: 'Saudi Riyal', SEK: 'Swedish Krona', SGD: 'Singapore Dollar', THB: 'Thai Baht', TWD: 'New Thaiwan Dollar', UAH: 'Ukrainian Hryvnia', USD: 'United States Dollar', VEF: 'Venezuelan Bolivar Bolívar',
  VND: 'Vietnamese Dong đồng', ZAR: 'South African Rand', TRY: 'Turkish Lira', KES: 'Kenyan Shillings',
};

/** FiatCurrencyPickerSheet: a fiat currency (the selected one marked) */
export function chooseFiat(selected: string): Promise<string | undefined> {
  return showSheet<string>((close) => <FiatPicker close={close} selected={selected} />, { full: true });
}

export function pickFiat() {
  return chooseFiat(settings.value.fiatCurrency).then((v) => {
    if (v) {
      updateSettings({ fiatCurrency: v });
      resetPrices();
    }
  });
}

function FiatPicker({ close, selected }: { close: (v?: string) => void; selected: string }) {
  const [q, setQ] = useState('');
  const sel = selected;
  const ql = q.toLowerCase();
  const match = (c: string) => !ql || c.toLowerCase().includes(ql) || FIAT_NAMES[c].toLowerCase().includes(ql);
  const popular = ['USD', 'EUR', 'GBP', 'JPY', 'CNY'].filter((c) => c !== sel);
  // _allSorted: by the lower-cased full name (code units)
  const lower = (c: string) => FIAT_NAMES[c].toLowerCase();
  const all = [...FIAT_CURRENCIES].sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0)).filter(match);
  const RowF = ({ c }: { c: string }) => (
    <button type="button" class="row tap" onClick={() => close(c)} id={`fiat_${c}`}>
      <img src={`./cake/images/flags/${FIAT_FLAG[c]}.png`} alt="" style={{ width: '28px', height: '20px', borderRadius: '4px', objectFit: 'cover' }} />
      <span class="lbl"><span style={{ fontWeight: 500 }}>{FIAT_NAMES[c]}</span><span class="sub">{c}</span></span>
      {c === sel && <MIcon name="check" size={20} color="var(--primary)" />}
    </button>
  );
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }}>
      <TopBar title={t('select_fiat_currency_title')} onClose={() => close()} />
      <div class="page-body" style={{ padding: '0 16px 90px' }}>
        {ql ? (
          // FiatCurrencySearchResults: the matches, or none
          all.length ? <div class="list" style={{ marginTop: '8px' }} id="fiat_search_results">{all.map((c) => <RowF c={c} />)}</div> : <div class="muted center" style={{ padding: '24px' }} id="fiat_no_matches">{t('picker_no_matches')}</div>
        ) : (
          <>
            <div class="muted" style={{ padding: '8px 4px', fontWeight: 500 }}>{t('picker_section_selected')}</div>
            <div class="list"><RowF c={sel} /></div>
            {popular.length > 0 && <><div class="muted" style={{ padding: '16px 4px 8px', fontWeight: 500 }}>{t('picker_section_popular')}</div><div class="list">{popular.map((c) => <RowF c={c} />)}</div></>}
            <div class="muted" style={{ padding: '16px 4px 8px', fontWeight: 500 }}>{t('picker_section_all_currencies')}</div>
            <div class="list">{all.map((c) => <RowF c={c} />)}</div>
          </>
        )}
      </div>
      <div style={{ position: 'absolute', left: '16px', right: '16px', bottom: '24px' }}>
        <div class="search" style={{ borderRadius: '28px' }}>
          <MIcon name="search" size={20} color="var(--primary)" />
          <input placeholder={t('search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
      </div>
    </div>
  );
}

function pickLanguage() {
  return showSheet<string>((close) => <LanguagePicker close={close} />, { full: true }).then(async (v) => {
    if (v) {
      await setLanguage(v);
      updateSettings({ languageCode: v });
    }
  });
}

function LanguagePicker({ close }: { close: (v?: string) => void }) {
  const [q, setQ] = useState('');
  const list = Object.entries(SUPPORTED_LOCALES).filter(([, name]) => name.toLowerCase().includes(q));
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }}>
      <TopBar title={t('settings_change_language')} onClose={() => close()} />
      <div style={{ padding: '0 18px 12px' }}><div class="search"><MIcon name="search" size={20} color="var(--on-surface-variant)" /><input placeholder={t('search_language')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></div></div>
      <div class="page-body" style={{ padding: '0 18px 24px' }}>
        <div class="list">
          {list.map(([code, name]) => (
            <button type="button" class="row tap" onClick={() => close(code)} id={`lang_${code}`}>
              <img src={`./cake/images/flags/${LOCALE_COUNTRY[code]}.png`} alt="" style={{ width: '28px', height: '20px', borderRadius: '4px', objectFit: 'cover' }} />
              <span class="lbl">{name}</span>
              {code === language.value && <MIcon name="check" size={20} color="var(--primary)" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- other --

function OtherSettingsPage() {
  const w = currentWallet.value;
  const s = settings.value;
  if (!w) return null;
  const pr = w.priorities();
  const cur = s.priority[w.type] ?? w.defaultPriority();
  return (
    <Page title={t('other')} solid id="other_settings_page">
      <Section>
        {pr.length > 0 && (
          <Row label={t('settings_fee_priority')} trailingText={pr.find((p) => p.id === cur)?.label ?? cur} id="other_fee_priority" onClick={async () => {
            const v = await pickOption(t('settings_fee_priority'), pr.filter((p) => !p.isCustom).map((p) => ({ id: p.id, label: p.rateLabel ? `${p.label} (${p.rateLabel})` : p.label })), cur);
            if (v) updateSettings((x) => ({ priority: { ...x.priority, [w.type]: v } }));
          }} />
        )}
        {w.type === 'nano' && <Row label={t('change_rep')} onClick={() => nav.push(Routes.changeRep)} />}
        {w.canSignMessages && <Row label={t('sign_verify_title')} id="other_sign_verify" onClick={() => nav.push(Routes.signPage)} />}
      </Section>
    </Page>
  );
}

// -------------------------------------------------------- support / about --

function SupportPage() {
  return (
    <Page title={t('settings_support')} solid id="support_page">
      <Sections>
        <Section>
          <Row label={t('support_title_live_chat')} subtitle={t('support_description_live_chat')} onClick={() => openExternal('https://support.cakewallet.com')} />
          <Row label={t('support_title_guides')} subtitle={t('support_description_guides')} onClick={() => openExternal('https://docs.cakewallet.com')} />
          <Row label={t('support_title_other_links')} subtitle={t('support_description_other_links')} onClick={() => nav.push(Routes.supportOtherLinks)} />
        </Section>
        <Section header="FAQ">
          <Row label="FAQ" onClick={() => nav.push(Routes.faq)} />
        </Section>
      </Sections>
    </Page>
  );
}

function SupportOtherLinksPage() {
  const links: [string, string][] = [
    ['Email', 'mailto:support@cakewallet.com'],
    ['Telegram', 'https://t.me/cakewallet_bot'],
    ['X (Twitter)', 'https://twitter.com/cakewallet'],
    ['ChangeNOW', 'https://changenow.io/faq'],
    ['Trocador', 'https://trocador.app/en/faq'],
    ['Cake Pay', 'mailto:support@cakepay.com'],
    ['GitHub (this web client)', 'https://codeberg.org/portbuster/cake-web'],
  ];
  return (
    <Page title={t('support_title_other_links')} solid>
      <Section>{links.map(([l, u]) => <Row label={l} subtitle={u.replace('mailto:', '')} onClick={() => (u.startsWith('mailto:') ? copyText(u.slice(7)) : openExternal(u))} />)}</Section>
    </Page>
  );
}

function FaqPage() {
  const [items, setItems] = useState<{ question: string; answer: string }[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const lang = ['de', 'es', 'fr', 'hi', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh'].includes(language.value) ? language.value : 'en';
    void fetch(`./cake/faq/faq_${lang}.json`).then((r) => r.json()).then((j) => setItems(j)).catch(() => {});
  }, []);
  return (
    <Page title="FAQ" solid id="faq_page">
      <div class="list">
        {items.map((it, i) => (
          <div class="row tap" style={{ flexDirection: 'column', alignItems: 'stretch' }} onClick={() => setOpen(open === i ? null : i)}>
            <span style={{ fontWeight: 500 }}>{it.question}</span>
            {open === i && <span class="muted" style={{ whiteSpace: 'pre-line', marginTop: '8px' }}>{it.answer}</span>}
          </div>
        ))}
      </div>
    </Page>
  );
}

const EASTER_EGGS = ['Cake is not a lie', 'Have a slice', 'Baked with love', 'Privacy is a right'];

function AboutPage() {
  const [taps, setTaps] = useState(0);
  return (
    <Page title={t('about')} solid id="about_page">
      <div class="col" style={{ alignItems: 'center', gap: '12px', paddingTop: '24px' }}>
        <img src="./cake/new-ui/cake_squircle_icon.svg" alt="Cake Wallet" style={{ width: '128px', height: '128px', cursor: 'pointer' }} onClick={() => setTaps(taps + 1)} />
        <div style={{ fontSize: '22px', fontWeight: 600 }}>Cake Wallet</div>
        <div class="muted">Web 0.1 · based on Cake Wallet 6.5.3</div>
        <div>{taps >= 5 ? EASTER_EGGS[taps % EASTER_EGGS.length] : t('payment_made_easy')}</div>
        <div style={{ width: '100%', marginTop: '24px' }} class="col gap16">
          <Section>
            <Row label="Official Website" onClick={() => openExternal('https://cakewallet.com')} />
            <Row label="Cake Docs" onClick={() => openExternal('https://docs.cakewallet.com')} />
          </Section>
          <Section>
            <Row label="GitHub" onClick={() => openExternal('https://github.com/cake-tech')} />
            <Row label="X (Twitter)" onClick={() => openExternal('https://twitter.com/cakewallet')} />
            <Row label="Telegram" onClick={() => openExternal('https://t.me/cakewallet')} />
            <Row label="Source of this web client" onClick={() => openExternal('https://codeberg.org/portbuster/cake-web')} />
          </Section>
        </div>
      </div>
    </Page>
  );
}

// -------------------------------------------------------- recovery & keys --

function ShowKeysDisclaimerPage() {
  const dark = document.documentElement.dataset.theme !== 'light';
  return (
    <Page id="show_keys_disclaimer" footer={
      <>
        <Button id="show_keys_button" onClick={async () => { if (await requireAuth({ always: true, totp: settings.value.shouldRequireTOTP2FAForAllSecurityAndBackupSettings })) nav.replace(Routes.showKeys); }}>{t('show_recovery_phrase_and_keys')}</Button>
        <Button secondary onClick={() => nav.pop()}>{t('seed_alert_back')}</Button>
      </>
    }>
      <div class="col" style={{ alignItems: 'center', gap: '12px', paddingTop: '24px', textAlign: 'center' }}>
        <Img src={`assets/new-ui/hero/seed_warning_${dark ? 'dark' : 'light'}.svg`} w={200} h={175} />
        <div style={{ fontSize: '18px', fontWeight: 600 }}>{t('secret_information_ahead')}</div>
        <div class="muted">{t('secret_information_ahead_description')}</div>
        <div style={{ color: 'var(--warning-outline)' }}>{t('secret_information_ahead_warning')}</div>
      </div>
    </Page>
  );
}

function WalletKeysPage() {
  const w = currentWallet.value;
  const [seed, setSeed] = useState('');
  const [pass, setPass] = useState('');
  const [keys, setKeys] = useState<WalletKeysRow[]>([]);
  const [tab, setTab] = useState<'seed' | 'keys'>('seed');
  const [showPass, setShowPass] = useState(false);
  useEffect(() => {
    if (!w) return;
    void getSecrets(w.id).then((s) => {
      setSeed(s.mnemonic ?? '');
      setPass(s.passphrase ?? '');
      if (!s.mnemonic || s.mnemonic.split(' ').length <= 10) setTab('keys');
    });
    void w.keys().then(setKeys).catch(() => setKeys([]));
  }, [w?.id]);
  if (!w) return null;
  const words = seed ? seed.split(/\s+/) : [];
  const qrScheme = `${w.type === 'bitcoinCash' ? 'bitcoincash' : w.type.toLowerCase()}-wallet`;
  const qrData = (() => {
    const p = new URLSearchParams();
    if (seed) p.set('seed', seed);
    else {
      const pk = keys.find((k) => /private key|seed \(hex/i.test(k.label))?.value;
      if (pk) p.set('private_key', pk);
    }
    if (w.info.restoreHeight) p.set('height', String(w.info.restoreHeight));
    if (pass || w.type === 'monero') p.set('passphrase', pass);
    return `${qrScheme}:?${p.toString()}`;
  })();
  return (
    <Page title={`${WALLET_TYPE_NAME[w.type]} ${t('wallet_keys')}`} legacy id="wallet_keys_page">
      <div class="warning-box" style={{ fontWeight: 700, textAlign: 'center', marginBottom: '16px' }}>{t('do_not_share_warning_text').toUpperCase()}</div>
      <div class="rowx gap24" style={{ marginBottom: '16px' }}>
        {words.length > 10 && <button type="button" onClick={() => setTab('seed')} style={{ background: 'none', border: 0, fontSize: '18px', fontWeight: 600, color: 'var(--on-surface)', opacity: tab === 'seed' ? 1 : 0.5, cursor: 'pointer' }}>{t('widgets_seed')}</button>}
        {keys.length > 0 && <button type="button" id="keys_tab" onClick={() => setTab('keys')} style={{ background: 'none', border: 0, fontSize: '18px', fontWeight: 600, color: 'var(--on-surface)', opacity: tab === 'keys' ? 1 : 0.5, cursor: 'pointer' }}>{t('keys')}</button>}
      </div>
      {tab === 'seed' ? (
        <div class="col gap16">
          {pass && (
            <div class="card rowx" style={{ justifyContent: 'space-between' }}>
              <span>{t('passphrase_view_keys')}: <span class="mono">{showPass ? pass : '*****'}</span></span>
              <button type="button" class="ficon" onClick={() => setShowPass(!showPass)}><MIcon name={showPass ? 'eyeOff' : 'eye'} size={20} /></button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
            {words.map((wd, i) => (
              <div style={{ background: 'var(--surface-container)', borderRadius: '8px', padding: '10px 8px', display: 'flex', gap: '6px' }}>
                <span style={{ fontWeight: 700, opacity: 0.5 }}>{i + 1}</span>
                <span style={{ fontWeight: 700 }}>{wd}</span>
              </div>
            ))}
          </div>
          <div class="rowx gap12">
            <Button secondary onClick={() => copyText(seed, t('copied_key_to_clipboard', { key: t('wallet_seed').toLowerCase() }))}>{t('copy')}</Button>
            <Button id="wallet_keys_page_show_qr_seeds_button_key" onClick={() => nav.push(Routes.fullscreenQR, { data: qrData })}>{`${t('show')} QR`}</Button>
          </div>
        </div>
      ) : (
        <Section>
          {keys.map((k) => <Row label={k.label} subtitle={<span class="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>{k.value}</span>} copy={k.value} />)}
        </Section>
      )}
    </Page>
  );
}

/** FullscreenQRPage: the code in a primary-bordered square, 90 % of the width */
function FullscreenQrPage({ args }: { args: { data: string } }) {
  return (
    <Page legacy id="fullscreen_qr_page" bodyClass="">
      <div style={{ padding: '0 5%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: '480px', aspectRatio: '1', padding: '10px', border: '3px solid var(--primary)', borderRadius: '16px', background: 'var(--surface)', boxSizing: 'border-box' }}>
          <div style={{ width: '100%', height: '100%', border: '3px solid var(--surface)', background: '#fff', boxSizing: 'border-box', display: 'flex' }}>
            <QrCode data={args.data} size="fill" id="fullscreen_qr" />
          </div>
        </div>
      </div>
    </Page>
  );
}

registerRoute(Routes.fullscreenQR, FullscreenQrPage);
registerRoute(Routes.securityBackupPage, SecurityPage);
registerRoute(Routes.setupDuressPin, (p: any) => {
  const C = routeComponent(Routes.setupPin);
  return C ? <C args={{ ...(p.args ?? {}), isDuress: true }} /> : null;
});
registerRoute(Routes.privacyPage, PrivacyPage);
registerRoute(Routes.displaySettingsPage, DisplayPage);
registerRoute(Routes.otherSettingsPage, OtherSettingsPage);
registerRoute(Routes.support, SupportPage);
registerRoute(Routes.supportOtherLinks, SupportOtherLinksPage);
registerRoute(Routes.faq, FaqPage);
registerRoute(Routes.aboutPage, AboutPage);
registerRoute(Routes.showKeysDisclaimer, ShowKeysDisclaimerPage);
registerRoute(Routes.showKeys, WalletKeysPage);
export { toast };
