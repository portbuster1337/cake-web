// Create-wallet flow: NewWalletTypePage → NewWalletPage (+ Advanced
// settings) → PreSeedPage → WalletSeedPage → SeedVerificationPage.

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../core/i18n.ts';
import { nav } from '../nav.ts';
import { registerRoute, Routes } from '../routes.ts';
import { Button, Field, Icon, Img, MIcon, Page, Segmented, ToggleRow, Section, Row, copyText } from '../components/core.tsx';
import { showAlert, showSheet } from '../components/overlays.tsx';
import { requireAuth } from '../components/auth.tsx';
import { currentPalette } from '../theme/themes.ts';
import { AVAILABLE_WALLET_TYPES, WALLET_TYPE_NAME, WALLET_TYPE_TICKER, walletCurrency, type WalletType } from '../../coins/types.ts';
import { coinModule, isCoinSupported } from '../../coins/module.ts';
import { generateName } from '../../core/names.ts';
import { createWallet, currentWallet, openWallet, walletNameTaken, getSecrets, walletInfos, saveWalletInfo } from '../../app/app.ts';
import { settings, updateSettings, type FiatApiMode, type ExchangeApiMode } from '../../app/settings.ts';
import type { WalletInfo } from '../../core/wallet.ts';
import { isBip39Wallet, joinableGroups } from '../../app/groups.ts';

const SEED_TYPES_BY_COIN: Partial<Record<WalletType, { id: string; label: string }[]>> = {
  monero: [
    { id: 'polyseed', label: 'Polyseed (16 words)' },
    { id: 'legacy', label: 'Legacy (25 words)' },
    { id: 'bip39', label: 'BIP39 (12 words)' },
  ],
  bitcoin: [
    { id: 'bip39', label: 'BIP39' },
    { id: 'electrum', label: 'Electrum' },
  ],
  litecoin: [
    { id: 'bip39', label: 'BIP39' },
    { id: 'electrum', label: 'Electrum' },
  ],
  nano: [
    { id: 'bip39', label: 'BIP39' },
    { id: 'nano', label: 'Nano' },
  ],
};

export function seedTypeOptions(type: WalletType) {
  return SEED_TYPES_BY_COIN[type];
}

/** advanced_privacy_settings_view_model.dart hasPassphraseOption (not Nano) */
const PASSPHRASE_TYPES = new Set<WalletType>(['bitcoin', 'litecoin', 'bitcoinCash', 'ethereum', 'polygon', 'base', 'arbitrum', 'bsc', 'robinhood', 'tron', 'solana', 'monero', 'wownero', 'zano', 'dogecoin', 'zcash', 'decred']);

/** hasSeedPhraseLengthOption: most chains; BTC/LTC and Nano only with a BIP39 seed; never Monero/Wownero */
function hasSeedPhraseLengthOption(type: WalletType, seedType?: string): boolean {
  switch (type) {
    case 'bitcoin':
    case 'litecoin':
    case 'nano':
      return seedType === 'bip39';
    case 'monero':
    case 'wownero':
    case 'haven':
      return false;
    default:
      return true;
  }
}

/** the Recovery phrase type choices (SettingsChoicesCell): MoneroSeedType / BitcoinSeedType / NanoSeedType .all */
const SEED_TYPE_CHOICES: Partial<Record<WalletType, { value: string; label: string }[]>> = {
  monero: [{ value: 'legacy', label: 'Legacy' }, { value: 'polyseed', label: 'Polyseed' }, { value: 'bip39', label: 'BIP39' }],
  bitcoin: [{ value: 'electrum', label: 'Electrum' }, { value: 'bip39', label: 'BIP39' }],
  litecoin: [{ value: 'electrum', label: 'Electrum' }, { value: 'bip39', label: 'BIP39' }],
  nano: [{ value: 'nano', label: 'Nano' }, { value: 'bip39', label: 'BIP39' }],
};

/** SeedSettingsViewModel: the seed types are settings (BTC and LTC share one) */
function persistSeedType(type: WalletType, v: string): void {
  if (type === 'monero') updateSettings({ moneroSeedType: v });
  else if (type === 'bitcoin' || type === 'litecoin') updateSettings({ bitcoinSeedType: v });
  else if (type === 'nano') updateSettings({ nanoSeedType: v });
}

function defaultSeedType(type: WalletType): string | undefined {
  const s = settings.value;
  // QUIRK (new_wallet_page.dart): opening the New Wallet page resets the Monero seed type to Polyseed
  if (type === 'monero') return 'polyseed';
  if (type === 'bitcoin' || type === 'litecoin') return s.bitcoinSeedType;
  if (type === 'nano') return s.nanoSeedType;
  return undefined;
}

/** NewWalletTypePage (create & restore modes) */
function NewWalletTypePage({ args }: { args?: { restore?: boolean; onSelected?: (t: WalletType) => void } }) {
  const dark = currentPalette().isDark;
  const select = (type: WalletType) => {
    if (!isCoinSupported(type)) {
      void showAlert({ title: WALLET_TYPE_NAME[type], content: t('coming_soon') === 'coming_soon' ? 'Coming soon' : t('coming_soon') });
      return;
    }
    if (args?.onSelected) return args.onSelected(type);
    if (args?.restore) nav.push(Routes.restoreWallet, { walletType: type });
    // onTypeSelected: with other wallets, a BIP39 type may share a group's recovery phrase
    else if (!isBip39Wallet(type) || !walletInfos.value.length) nav.push(Routes.newWallet, { type });
    else nav.push(Routes.walletGroupDescription, { type });
  };
  return (
    <Page title={args?.restore ? t('wallet_list_restore_wallet') : t('wallet_list_create_new_wallet')} legacy id="new_wallet_type_page">
      <div class="col gap24" style={{ alignItems: 'center', paddingTop: '8px' }}>
        <Img src={`assets/new-ui/hero/welcome_wallet_${dark ? 'dark' : 'light'}.svg`} size={100} />
        <div class="muted center">{t('choose_wallet_currency')}</div>
        <div class="list" style={{ width: '100%' }}>
          {AVAILABLE_WALLET_TYPES.map((type) => (
            <button type="button" class="row tap has-icon" style={{ minHeight: '50px' }} id={`wallet_type_${type}`} onClick={() => select(type)}>
              <Img src={walletCurrency(type).iconPath ?? undefined} size={24} />
              <span class="lbl" style={{ flexDirection: 'row', gap: '4px' }}>
                <span>{WALLET_TYPE_NAME[type]}</span>
                {WALLET_TYPE_TICKER[type] && <span class="muted">{WALLET_TYPE_TICKER[type]}</span>}
              </span>
              <Icon src="arrow_forward.svg" w={9} h={16} color="var(--on-surface-variant)" />
            </button>
          ))}
        </div>
      </div>
    </Page>
  );
}

interface NewWalletDraft {
  seedType?: string;
  wordCount?: number;
  passphrase?: string;
}

/** NewWalletPage */
function NewWalletPage({ args }: { args: { type: WalletType; mnemonic?: string; parentId?: string; isChildWallet?: boolean } }) {
  const type = args.type;
  const dark = currentPalette().isDark;
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<NewWalletDraft>(() => ({ seedType: defaultSeedType(type), wordCount: settings.value.seedPhraseLength === 24 ? 24 : 12 }));
  useEffect(() => updateSettings({ moneroSeedType: 'polyseed' }), []);
  const [busy, setBusy] = useState(false);
  const seedTypes = seedTypeOptions(type);

  const next = async () => {
    const n = name.trim();
    if (!n) return;
    if (walletNameTaken(n)) {
      await showAlert({ title: t('new_wallet'), content: t('wallet_name_exists'), right: t('ok') });
      return;
    }
    setBusy(true);
    try {
      const created = await createWallet(type, { name: n, seedType: args.mnemonic ? 'bip39' : draft.seedType, passphrase: draft.passphrase, wordCount: draft.wordCount, mnemonic: args.mnemonic });
      // WalletNewVM: a new recovery phrase is to be backed up (a group's one is already)
      const info = { ...created, showSeedBackupReminder: !args.mnemonic };
      await saveWalletInfo(info);
      await openWallet(info.id);
      // a wallet in a group: its recovery phrase is the group's, already known
      if (args.isChildWallet) nav.push(Routes.walletGroupExistingSeedDescriptionPage, { walletId: info.id });
      else nav.push(Routes.preSeedPage, { walletId: info.id });
    } catch (e) {
      await showAlert({ title: t('new_wallet'), content: (e as Error).message, right: t('ok') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title={t('new_wallet')}
      legacy
      id="new_wallet_page"
      footer={
        <>
          <Button secondary id="new_wallet_page_advanced_settings_button_key" onClick={() => nav.push(Routes.advancedPrivacySettings, { type, draft, onChange: (d: NewWalletDraft) => setDraft(d), isFromRestore: false, isChildWallet: !!args.mnemonic || !!args.isChildWallet })}>
            {t('advanced_settings')}
          </Button>
          <Button id="new_wallet_page_confirm_button_key" disabled={!name.trim()} loading={busy} onClick={next}>
            {t('seed_language_next')}
          </Button>
        </>
      }
    >
      <div class="col gap24" style={{ paddingTop: '8px' }}>
        <Img src={`assets/new-ui/hero/wallet_type_${dark ? 'dark' : 'light'}.svg`} w={300} h={200} style={{ width: '100%', height: 'auto', maxHeight: '220px' }} />
        <Field
          id="new_wallet_page_wallet_name_textformfield_key"
          value={name}
          onInput={setName}
          placeholder={t('wallet_name')}
          maxLength={64}
          suffix={
            <button type="button" class="ficon" aria-label={t('generate_name')} id="new_wallet_page_wallet_name_textformfield_generate_name_button_key" onClick={() => setName(generateName())} style={{ background: 'var(--surface)', borderRadius: '12px', width: '34px', height: '34px', alignItems: 'center', justifyContent: 'center' }}>
              <img src="./cake/images/refresh_icon.png" alt="" style={{ width: '16px', opacity: 0.7 }} />
            </button>
          }
        />
        {type === 'monero' && seedTypes && (
          <button type="button" class="field" style={{ minHeight: '60px', cursor: 'pointer', justifyContent: 'space-between', fontSize: '18px', fontWeight: 500 }} onClick={async () => {
            const v = await pickOption(t('seedtype'), seedTypes, draft.seedType);
            if (v) {
              setDraft({ ...draft, seedType: v });
              updateSettings({ moneroSeedType: v });
            }
          }}>
            <span>{seedTypes.find((s) => s.id === draft.seedType)?.label}</span>
            <MIcon name="chevronDown" color="var(--on-surface-variant)" />
          </button>
        )}
      </div>
    </Page>
  );
}

export function pickOption(title: string, options: { id: string; label: string; sub?: string }[], selected?: string): Promise<string | undefined> {
  return showSheet<string>((close) => (
    <div style={{ padding: '0 12px 16px' }}>
      <div class="topbar" style={{ height: '64px' }}>
        <span class="spacer" />
        <div class="t" style={{ top: '22px' }}>{title}</div>
        <span class="spacer" />
      </div>
      <div class="picker-rows">
        {options.map((o) => (
          <button type="button" class="picker-row" onClick={() => close(o.id)}>
            <span class="pt">
              <b>{o.label}</b>
              {o.sub && <span>{o.sub}</span>}
            </span>
            <span class={`check${o.id === selected ? ' on' : ''}`}>{o.id === selected && <MIcon name="check" size={18} />}</span>
          </button>
        ))}
      </div>
    </div>
  ));
}

/** AdvancedPrivacySettingsPage */
function AdvancedPrivacySettingsPage({ args }: { args: { type: WalletType; draft: NewWalletDraft; onChange: (d: NewWalletDraft) => void; isFromRestore?: boolean; isChildWallet?: boolean } }) {
  const type = args.type;
  const child = !!args.isChildWallet;
  // a child wallet shares its parent's BIP39 phrase: BTC and Nano are forced to BIP39 (and that is persisted)
  const [d, setD] = useState<NewWalletDraft>(() => {
    const x = { ...(args.draft ?? {}) };
    if (args.isFromRestore) x.seedType = (type === 'monero' ? settings.value.moneroSeedType : defaultSeedType(type)) ?? x.seedType;
    if (child && (type === 'bitcoin' || type === 'litecoin' || type === 'nano')) x.seedType = 'bip39';
    return x;
  });
  useEffect(() => {
    if (child) updateSettings({ bitcoinSeedType: 'bip39', nanoSeedType: 'bip39' });
  }, []);
  const [confirm, setConfirm] = useState(d.passphrase ?? '');
  const [showPass, setShowPass] = useState(false);
  const s = settings.value;
  const choices = SEED_TYPE_CHOICES[type];
  const showSeedType = !!choices && !(child && (type === 'monero' || type === 'wownero'));
  const passMismatch = (d.passphrase ?? '') !== confirm;
  const supportsPassphrase = PASSPHRASE_TYPES.has(type);
  const supportsLength = hasSeedPhraseLengthOption(type, d.seedType);
  const modes: { value: FiatApiMode; label: string }[] = [
    { value: 'enabled', label: t('enabled') },
    { value: 'torOnly', label: t('tor_only') },
    { value: 'disabled', label: t('disabled') },
  ];
  const setSeedType = async (v: string) => {
    if (child && v !== 'bip39') {
      await showAlert({ title: t('seedtype_alert_title'), content: t('seedtype_alert_content') });
      return;
    }
    setD({ ...d, seedType: v });
    persistSeedType(type, v);
  };
  return (
    <Page
      title={t('privacy_settings')}
      legacy
      id="advanced_privacy_settings_page"
      footer={
        <>
          <div class="center muted" style={{ width: '80%', margin: '0 auto' }}>{t('settings_can_be_changed_later')}</div>
          <Button
            id="advanced_privacy_settings_page_continue_button_key"
            disabled={passMismatch}
            onClick={() => {
              args.onChange(d);
              nav.pop();
            }}
          >
            {t('continue_text')}
          </Button>
        </>
      }
    >
      <div class="col gap24" style={{ paddingTop: '16px' }}>
        <div class="col gap12">
          <div>{t('fiat_api')}</div>
          <Segmented options={modes} value={s.fiatApiMode} onChange={(v) => updateSettings({ fiatApiMode: v })} />
        </div>
        <div class="col gap12">
          <div>{t('swap')}</div>
          <Segmented options={modes as { value: ExchangeApiMode; label: string }[]} value={s.exchangeStatus} onChange={(v) => updateSettings({ exchangeStatus: v })} />
        </div>
        {showSeedType && (
          <div class="col gap12" id="advanced_privacy_settings_seed_type">
            <div>{t('seedtype')}</div>
            <Segmented options={choices!} value={d.seedType ?? choices![choices!.length - 1].value} onChange={(v) => void setSeedType(v)} />
          </div>
        )}
        {!args.isFromRestore && supportsLength && (
          <Section>
            <Row
              label={t('seed_phrase_length')}
              id="advanced_privacy_settings_seed_length"
              trailingText={`${d.wordCount === 24 ? 24 : 12} Words`}
              onClick={async () => {
                const v = await pickOption(t('seed_phrase_length'), [{ id: '12', label: '12 Words' }, { id: '24', label: '24 Words' }], String(d.wordCount === 24 ? 24 : 12));
                if (v) {
                  setD({ ...d, wordCount: Number(v) });
                  updateSettings({ seedPhraseLength: Number(v) });
                }
              }}
            />
          </Section>
        )}
        {!args.isFromRestore && supportsPassphrase && (
          <div class="col gap12">
            <Field
              value={d.passphrase ?? ''}
              onInput={(v) => setD({ ...d, passphrase: v })}
              placeholder={t('passphrase')}
              type={showPass ? 'text' : 'password'}
              id="advanced_privacy_settings_passphrase"
              suffix={<button type="button" class="ficon" onClick={() => setShowPass(!showPass)}><MIcon name={showPass ? 'eyeOff' : 'eye'} size={20} /></button>}
            />
            <Field value={confirm} onInput={setConfirm} placeholder={t('confirm_passphrase')} type={showPass ? 'text' : 'password'} error={passMismatch && confirm ? t('passphrases_doesnt_match') : null} id="advanced_privacy_settings_confirm_passphrase" />
          </div>
        )}
        <Section>
          <ToggleRow label={t('disable_bulletin')} value={s.disableBulletin} onChange={(v) => updateSettings({ disableBulletin: v })} />
        </Section>
      </div>
    </Page>
  );
}

/** PreSeedPage */
function PreSeedPage({ args }: { args: { walletId: string; reminder?: boolean } }) {
  const dark = currentPalette().isDark;
  const [checks, setChecks] = useState([false, false, false]);
  const all = checks.every(Boolean);
  const items: [string, string][] = [
    ['key.svg', 'recovery_phrase_check_only_way'],
    ['set-amount.svg', 'recovery_phrase_check_write_down'],
    ['visibility.svg', 'recovery_phrase_check_never_share'],
  ];
  return (
    <Page
      noBack={!args.reminder}
      id="pre_seed_page"
      footer={
        all ? (
          <>
            <Button id="pre_seed_page_button_key" onClick={() => nav.push(Routes.seed, { walletId: args.walletId, isNewWalletCreated: true })}>
              {t('show_recovery_phrase')}
            </Button>
            <button type="button" class="link-btn" onClick={() => nav.push('/skip_seed_verification', { walletId: args.walletId })}>
              {t('skip_this_step')}
            </button>
          </>
        ) : undefined
      }
    >
      <div class="col" style={{ alignItems: 'center', paddingTop: '24px' }}>
        <Img src={`assets/new-ui/hero/seed_shield_${dark ? 'dark' : 'light'}.svg`} w={200} h={175} />
        <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '24px', textAlign: 'center', letterSpacing: '-0.09px' }}>{t('recovery_phrase_intro_title')}</div>
        <div class="muted center" style={{ marginTop: '12px' }}>{t('recovery_phrase_intro_description')}</div>
        <div class="col gap12" style={{ marginTop: '24px', width: '100%' }}>
          {items.map(([icon, key], i) => (
            <div class="rowx gap12" style={{ background: 'var(--surface-container)', borderRadius: '18px', padding: '16px 12px', cursor: 'pointer' }} id={`pre_seed_check_${i}`} onClick={() => setChecks(checks.map((c, j) => (j === i ? !c : c)))}>
              <Icon src={icon} size={24} color="var(--primary)" />
              <span class="grow" style={{ fontSize: '12px', color: 'var(--primary)' }}>{t(key)}</span>
              <span class={`check${checks[i] ? ' on' : ''}`}>{checks[i] && <MIcon name="check" size={18} />}</span>
            </div>
          ))}
          {!all && <div class="center" style={{ color: 'var(--warning-outline)', fontSize: '12px' }}>{t('recovery_phrase_check_all_to_proceed')}</div>}
        </div>
      </div>
    </Page>
  );
}

function SkipSeedVerificationPage({ args }: { args: { walletId: string } }) {
  return (
    <Page id="skip_seed_page" footer={
      <>
        <Button warning id="skip_verification_confirm" onClick={() => finishOnboarding(args.walletId, false)}>{t('skip_verification_confirm')}</Button>
        <Button secondary onClick={() => nav.pop()}>{t('seed_alert_back')}</Button>
      </>
    }>
      <div class="col" style={{ alignItems: 'center', paddingTop: '48px', gap: '24px', maxWidth: '295px', margin: '0 auto', textAlign: 'center' }}>
        <Img src="assets/new-ui/warning_triangle.svg" w={125} h={112} />
        <div style={{ fontSize: '18px', fontWeight: 600 }}>{t('skip_verification_title')}</div>
        <div style={{ color: 'var(--warning-outline)' }}>{t('skip_verification_warning')}</div>
        <div class="muted">{t('skip_verification_question')}</div>
      </div>
    </Page>
  );
}

export function finishOnboarding(walletId: string, verified: boolean) {
  if (verified) {
    updateSettings((s) => ({ seedBackedUp: { ...s.seedBackedUp, [walletId]: true } }));
    // WalletSeedViewModel.markSeedVerified
    void clearSeedBackupReminder(walletId);
  }
  nav.reset(Routes.dashboard);
}

/** WalletInfo.clearSeedBackupReminder */
export async function clearSeedBackupReminder(walletId: string): Promise<void> {
  const info = walletInfos.value.find((w) => w.id === walletId);
  if (info && info.showSeedBackupReminder !== false) await saveWalletInfo({ ...info, showSeedBackupReminder: false });
  const cur = currentWallet.value;
  if (cur?.id === walletId) (cur.info as WalletInfo).showSeedBackupReminder = false;
}

/** SeedBackupReminderPage: the recovery phrase (after the PIN), or dismiss the reminder */
function SeedBackupReminderPage({ args }: { args: { walletId: string } }) {
  const dark = currentPalette().isDark;
  return (
    <Page
      id="seed_backup_reminder_page"
      footer={
        <>
          <Button id="seed_backup_reminder_page_button_key" onClick={async () => {
            if (await requireAuth({ always: true, totp: settings.value.shouldRequireTOTP2FAForAllSecurityAndBackupSettings })) nav.push(Routes.seed, { walletId: args.walletId, isNewWalletCreated: false });
          }}>{t('show_recovery_phrase')}</Button>
          <button type="button" class="link-btn" id="seed_backup_reminder_page_dismiss_button_key" onClick={() => nav.push(Routes.dismissSeedVerification, { walletId: args.walletId })}>{t('dismiss_this_step')}</button>
        </>
      }
    >
      <div class="col" style={{ alignItems: 'center', paddingTop: '24px' }}>
        <Img src={`assets/new-ui/hero/seed_shield_${dark ? 'dark' : 'light'}.svg`} w={200} h={175} />
        <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '24px', textAlign: 'center', letterSpacing: '-0.09px' }}>{t('recovery_phrase_intro_title')}</div>
        <div class="muted center" style={{ marginTop: '12px' }}>{t('recovery_phrase_intro_description')}</div>
      </div>
    </Page>
  );
}

/** DismissSeedVerificationPage */
function DismissSeedVerificationPage({ args }: { args: { walletId: string } }) {
  return (
    <Page
      id="dismiss_seed_verification_page"
      footer={
        <>
          <Button id="dismiss_seed_verification_page_confirm_button_key" onClick={async () => {
            await clearSeedBackupReminder(args.walletId);
            nav.popUntil(Routes.dashboard);
          }}>{t('dismiss_verification_confirm')}</Button>
          <Button secondary id="dismiss_seed_verification_page_back_button_key" onClick={() => nav.pop()}>{t('seed_alert_back')}</Button>
        </>
      }
    >
      <div class="col" style={{ alignItems: 'center', paddingTop: '24px', maxWidth: '295px', margin: '0 auto', textAlign: 'center' }}>
        <Img src="assets/new-ui/warning_triangle.svg" w={125} h={112} />
        <div style={{ height: '48px' }} />
        <div style={{ fontSize: '18px', fontWeight: 600 }}>{t('dismiss_verification_title')}</div>
        <div style={{ height: '24px' }} />
        <div class="muted">
          {t('dismiss_verification_description')}
          <br />
          <b style={{ color: 'var(--on-surface)' }}>{t('seed_display_path')}</b>
        </div>
      </div>
    </Page>
  );
}

/** WalletSeedPage */
function WalletSeedPage({ args }: { args: { walletId: string; isNewWalletCreated?: boolean } }) {
  const info = walletInfos.value.find((w) => w.id === args.walletId) as WalletInfo | undefined;
  const [seed, setSeed] = useState<string>('');
  const [pass, setPass] = useState<string>('');
  useEffect(() => {
    void getSecrets(args.walletId).then((s) => {
      setSeed(s.mnemonic ?? '');
      setPass(s.passphrase ?? '');
    });
  }, [args.walletId]);
  const words = seed ? seed.split(/\s+/) : [];
  const typeName = info ? WALLET_TYPE_NAME[info.type] : '';
  return (
    <Page
      title={`${typeName} ${t('seed_title')}`}
      legacy
      id="wallet_seed_page"
      trailing={
        <button type="button" class="ficon" aria-label={t('copy')} id="wallet_seed_page_copy_seeds_button_key" style={{ width: '40px', height: '40px', background: 'var(--surface-container-highest)', borderRadius: '8px', alignItems: 'center', justifyContent: 'center' }} onClick={() => void copyText(seed)}>
          <Icon src="copy.svg" size={18} color="var(--on-surface-variant)" />
        </button>
      }
      footer={
        <div class="rowx gap12">
          <Button secondary onClick={() => saveSeedFile(info?.name ?? 'wallet', seed, pass)}>{t('save')}</Button>
          <Button id="wallet_seed_page_verify_seed_button_key" onClick={() => nav.push(Routes.walletSeedVerificationPage, { walletId: args.walletId, seed })}>
            {t('verify_phrase')}
          </Button>
        </div>
      }
    >
      <div class="col gap24" style={{ paddingTop: '16px' }}>
        <div class="rowx gap8" style={{ background: 'var(--warning-container)', border: '2px solid var(--warning-outline)', borderRadius: '12px', padding: '8px 12px' }}>
          <MIcon name="warning" size={48} color="var(--on-surface)" />
          <span style={{ fontSize: '12px', fontWeight: 800, textAlign: 'center', flex: 1 }}>{t('cake_seeds_save_disclaimer')}</span>
        </div>
        <div style={{ fontSize: '18px', fontWeight: 600, textAlign: 'center' }}>{info?.name}</div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${words.length > 13 ? 3 : 3}, 1fr)`, gap: '8px' }} id="seed_grid">
          {words.map((w, i) => (
            <div style={{ background: 'var(--surface-container)', borderRadius: '8px', padding: '10px 8px', display: 'flex', gap: '6px', alignItems: 'baseline' }}>
              <span style={{ fontWeight: 700, fontSize: '16px', opacity: 0.5 }}>{i + 1}</span>
              <span style={{ fontWeight: 700 }} class="seed-word">{w}</span>
            </div>
          ))}
        </div>
        {pass && (
          <Section>
            <Row label={t('passphrase_view_keys') === 'passphrase_view_keys' ? 'Passphrase' : t('passphrase_view_keys')} subtitle={pass} copy={pass} />
          </Section>
        )}
      </div>
    </Page>
  );
}

function saveSeedFile(name: string, seed: string, passphrase: string) {
  const text = `${name}\n\n${seed}${passphrase ? `\n\nPassphrase: ${passphrase}` : ''}\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `${name.replace(/[^\w.-]+/g, '_')}_recovery_phrase.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** SeedVerificationPage: asks for random word positions (Cake asks 2 rounds with 3 choices each). */
function SeedVerificationPage({ args }: { args: { walletId: string; seed: string } }) {
  const words = useMemo(() => args.seed.split(/\s+/), [args.seed]);
  const rounds = useMemo(() => {
    const idx = new Set<number>();
    while (idx.size < Math.min(2, words.length)) idx.add(crypto.getRandomValues(new Uint32Array(1))[0] % words.length);
    return [...idx];
  }, [words]);
  const [step, setStep] = useState(0);
  const [wrong, setWrong] = useState(0);
  const dark = currentPalette().isDark;
  const done = step >= rounds.length;
  const pos = rounds[step];
  const options = useMemo(() => {
    if (done) return [];
    const set = new Set<string>([words[pos]]);
    const pool = words.filter((w) => w !== words[pos]);
    while (set.size < Math.min(6, words.length) && pool.length) set.add(pool.splice(crypto.getRandomValues(new Uint32Array(1))[0] % pool.length, 1)[0]);
    return [...set].sort(() => (crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 1 : -1));
  }, [step, done]);
  if (done) {
    return (
      <Page title={t('verify_seed')} legacy id="seed_verified_page" footer={<Button id="seed_verified_open_wallet" onClick={() => finishOnboarding(args.walletId, true)}>{t('open_wallet')}</Button>}>
        <div class="col" style={{ alignItems: 'center', paddingTop: '48px', textAlign: 'center' }}>
          <Img src={`assets/images/seed_verified_${dark ? 'dark' : 'light'}.png`} w={128} h={128} />
          <div style={{ fontSize: '20px', fontWeight: 600, marginTop: '40px' }}>{t('seed_verified')}</div>
          <div class="muted" style={{ fontSize: '16px', marginTop: '48px', whiteSpace: 'pre-line' }}>
            {t('seed_verified_subtext')} <b>{t('seed_display_path')}</b>
          </div>
        </div>
      </Page>
    );
  }
  return (
    <Page title={t('verify_seed')} legacy id="seed_verification_page">
      <div class="col" style={{ alignItems: 'center', paddingTop: '48px', gap: '24px' }}>
        <div style={{ fontSize: '16px', fontWeight: 600, textAlign: 'center' }}>
          {t('seed_position_question_one')} <b style={{ fontWeight: 800 }}>{ordinal(pos + 1)}</b> {t('seed_position_question_two')}
        </div>
        <div class="rowx" style={{ flexWrap: 'wrap', gap: '8px', justifyContent: 'center' }}>
          {options.map((o) => (
            <button
              type="button"
              class="seed-option"
              style={{ padding: '8px 24px', borderRadius: '16px', background: 'var(--surface-container-highest)', border: 0, fontSize: '16px', fontWeight: 800, color: 'var(--on-surface-variant)', cursor: 'pointer' }}
              onClick={async () => {
                if (o === words[pos]) {
                  setStep(step + 1);
                  return;
                }
                if (wrong >= 1) {
                  await showAlert({ content: t('incorrect_seed_option_back') });
                  nav.pop();
                  return;
                }
                setWrong(wrong + 1);
                await showAlert({ content: t('incorrect_seed_option') });
              }}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
    </Page>
  );
}

// ------------------------------------------------------------ wallet groups --

const heroImg = (name: string) => <Img src={`assets/new-ui/hero/${name}_${currentPalette().isDark ? 'dark' : 'light'}.svg`} w={200} h={200} style={{ height: '200px', width: 'auto', maxWidth: '100%' }} />;

/** WalletGroupDescriptionPage: a new recovery phrase, or one of a wallet group */
function WalletGroupDescriptionPage({ args }: { args: { type: WalletType } }) {
  return (
    <Page
      title={t('wallet_list_create_new_wallet')}
      legacy
      id="wallet_group_description_page"
      footer={
        <>
          <Button secondary id="wallet_group_description_page_create_new_seed_button_key" style={{ color: 'var(--on-secondary-container)' }} onClick={() => nav.push(Routes.newWallet, { type: args.type })}>{t('create_new_seed')}</Button>
          <Button id="wallet_group_description_page_choose_wallet_group_button_key" onClick={() => nav.push(Routes.walletGroupsDisplayPage, { type: args.type })}>{t('choose_wallet_group')}</Button>
        </>
      }
    >
      <div class="col" style={{ alignItems: 'center', padding: '48px 0 0' }}>
        {heroImg('wallet_group_options')}
        <div style={{ height: '40px' }} />
        <div class="center" style={{ fontSize: '16px', lineHeight: 1.5, color: 'var(--on-surface-variant)' }} id="wallet_group_description_text">
          {`${t('wallet_group_description_one')} `}
          <b>{`${t('wallet_group').toLowerCase()} `}</b>
          {`${t('wallet_group_description_two')} `}
          <b>{`${t('choose_wallet_group')} `}</b>
          {`${t('wallet_group_description_three')} `}
          <b>{`${t('create_new_seed')} `}</b>
          {t('wallet_group_description_four')}
        </div>
      </div>
    </Page>
  );
}

/** GroupedWalletExpansionTile */
function GroupTile({ title, leading, wallets, selected, onSelect, id }: { title: string; leading: ComponentChildren; wallets?: WalletInfo[]; selected: boolean; onSelect: () => void; id: string }) {
  const [open, setOpen] = useState(false);
  const fg = selected ? 'var(--on-primary)' : 'var(--on-surface)';
  return (
    <div style={{ borderRadius: '16px', overflow: 'hidden', background: selected ? 'var(--primary)' : 'var(--surface-container)', margin: '0 0 10px' }} id={id}>
      <div class="rowx" style={{ gap: '16px', padding: '14px 16px', cursor: 'pointer', color: fg }} onClick={onSelect}>
        {leading}
        <span class="grow" style={{ fontSize: '18px', fontWeight: 500 }}>{title}</span>
        {!!wallets?.length && (
          <button type="button" aria-label={t('show_details')} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} style={{ border: 0, background: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}>
            <MIcon name="chevronDown" color={selected ? 'var(--on-primary)' : 'var(--on-surface-variant)'} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
          </button>
        )}
      </div>
      {open && wallets?.map((w) => (
        <div class="rowx" style={{ gap: '16px', padding: '10px 16px 10px 47px', cursor: 'pointer', color: fg }} onClick={onSelect}>
          <Img src={walletCurrency(w.type).iconPath ?? undefined} size={32} />
          <span style={{ fontSize: '18px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.name}</span>
        </div>
      ))}
    </div>
  );
}

/** WalletGroupsDisplayPage: the groups a wallet of this type can join, then the new wallet with that recovery phrase */
function WalletGroupsDisplayPage({ args }: { args: { type: WalletType } }) {
  const { multi, single } = joinableGroups(walletInfos.value, args.type);
  const [sel, setSel] = useState<{ group?: string; wallet?: string }>({});
  const [busy, setBusy] = useState(false);
  const none = !multi.length && !single.length;
  const next = async () => {
    if (none) {
      nav.push(Routes.newWallet, { type: args.type });
      return;
    }
    // getSelectedWalletMnemonic: the recovery phrase of the group's first wallet
    const w = sel.group ? multi.find((g) => g.key === sel.group)?.wallets[0] : single.find((x) => x.id === sel.wallet);
    if (!w) return;
    setBusy(true);
    try {
      const mnemonic = (await getSecrets(w.id)).mnemonic;
      nav.push(Routes.newWallet, { type: args.type, mnemonic, isChildWallet: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title={t('wallet_group')}
      solid
      id="wallet_groups_display_page"
      footer={<Button id="wallet_group_display_page_next_button_key" loading={busy} disabled={!none && !sel.group && !sel.wallet} onClick={() => void next()}>{none ? t('create_new_seed') : t('seed_language_next')}</Button>}
    >
      <div class="col" style={{ paddingTop: '48px' }}>
        {none && (
          <div class="col" style={{ alignItems: 'center', paddingTop: '16px' }} id="wallet_group_empty">
            {heroImg('wallet_group_empty')}
            <div style={{ height: '60px' }} />
            <div class="center" style={{ fontSize: '16px', lineHeight: 1.5, color: 'var(--on-surface-variant)', whiteSpace: 'pre-line' }}>
              {`${t('wallet_group_empty_state_text_one')} `}
              <b>{`${t('create_new_seed')} `}</b>
              {t('wallet_group_empty_state_text_two')}
            </div>
          </div>
        )}
        {multi.map((g, i) => (
          <GroupTile
            id={`wallet_group_${i}`}
            title={settings.value.walletGroupNames[g.key] ?? `${t('wallet_group')} ${i + 1}`}
            leading={<MIcon name="account_balance_wallet_outlined" size={28} />}
            wallets={g.wallets}
            selected={sel.group === g.key}
            onSelect={() => setSel({ group: g.key })}
          />
        ))}
        {single.map((w) => (
          <GroupTile id={`wallet_group_single_${w.id}`} title={w.name} leading={<Img src={walletCurrency(w.type).iconPath ?? undefined} size={32} />} selected={sel.wallet === w.id} onSelect={() => setSel({ wallet: w.id })} />
        ))}
      </div>
    </Page>
  );
}

/** WalletGroupExistingSeedDescriptionPage: the wallet shares a recovery phrase already written down */
function WalletGroupExistingSeedPage({ args }: { args: { walletId: string } }) {
  return (
    <Page
      title={t('wallet_group')}
      legacy
      id="wallet_group_existing_seed_page"
      footer={
        <div class="rowx" style={{ gap: '16px' }}>
          <div class="grow"><Button secondary style={{ color: 'var(--on-secondary-container)' }} id="wallet_group_existing_seed_description_page_verify_seed_button_key" onClick={() => nav.push(Routes.preSeedPage, { walletId: args.walletId })}>{t('verify_phrase')}</Button></div>
          <div class="grow"><Button id="wallet_group_existing_seed_description_page_open_wallet_button_key" onClick={() => nav.reset(Routes.dashboard)}>{t('open_wallet')}</Button></div>
        </div>
      }
    >
      <div class="col" style={{ alignItems: 'center', paddingTop: '24px' }}>
        {heroImg('wallet_group_confirmed')}
        <div style={{ height: '32px' }} />
        <div class="center" style={{ fontSize: '16px', lineHeight: 1.5, color: 'var(--on-surface-variant)' }} id="wallet_group_existing_seed_text">
          {t('wallet_group_description_existing_seed')}
          <br />
          <br />
          {t('wallet_group_description_open_wallet')}
          <br />
          <br />
          {t('wallet_group_description_view_seed')}
          <br />
          <b style={{ fontWeight: 800 }}>{t('seed_display_path')}</b>
        </div>
      </div>
    </Page>
  );
}

registerRoute(Routes.newWalletType, NewWalletTypePage);
registerRoute(Routes.newWalletFromWelcome, NewWalletTypePage);
registerRoute(Routes.restoreWalletType, (p) => <NewWalletTypePage args={{ ...(p.args ?? {}), restore: true }} />);
// restoreWalletTypeFromQR: the type of a scanned wallet that the code does not name
registerRoute(Routes.restoreWalletTypeFromQR, () => <NewWalletTypePage args={{ restore: true, onSelected: (type) => nav.pop(type) }} />);
registerRoute(Routes.newWallet, NewWalletPage);
registerRoute(Routes.advancedPrivacySettings, AdvancedPrivacySettingsPage);
registerRoute(Routes.preSeedPage, PreSeedPage);
registerRoute('/skip_seed_verification', SkipSeedVerificationPage);
registerRoute(Routes.seed, WalletSeedPage);
registerRoute(Routes.walletSeedVerificationPage, SeedVerificationPage);

export { coinModule };
registerRoute(Routes.walletGroupDescription, WalletGroupDescriptionPage);
registerRoute(Routes.walletGroupsDisplayPage, WalletGroupsDisplayPage);
registerRoute(Routes.walletGroupExistingSeedDescriptionPage, WalletGroupExistingSeedPage);
registerRoute(Routes.seedBackupReminderPage, SeedBackupReminderPage);
registerRoute(Routes.dismissSeedVerification, DismissSeedVerificationPage);
