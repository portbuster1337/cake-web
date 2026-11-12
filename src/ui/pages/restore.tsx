// Restore: RestoreOptionsPage, WalletRestorePage (seed / keys tabs),
// WalletRestoreChooseDerivationPage (lib/src/screens/restore/*).

import { useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { Button, Field, Img, MIcon, Page, Spinner } from '../components/core.tsx';
import { showAlert, showSheet } from '../components/overlays.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { currentPalette } from '../theme/themes.ts';
import { coinModule, type DerivationCandidate } from '../../coins/module.ts';
import { generateName } from '../../core/names.ts';
import { restoreWalletFromSeed, restoreWalletFromKeys, openWallet, walletNameTaken } from '../../app/app.ts';
import { WALLET_TYPE_NAME, type WalletType, isEvm } from '../../coins/types.ts';
import { validateWalletName } from './dashboard/wallets.tsx';
import { pickOption } from './newWallet.tsx';
import { estimateMoneroHeight } from '../../coins/heights.ts';

function OptionTile({ image, title, description, onClick, id }: { image: string; title: string; description: string; onClick: () => void; id?: string }) {
  return (
    <button type="button" id={id} onClick={onClick} class="rowx" style={{ width: '100%', gap: '20px', padding: '24px', borderRadius: '15px', border: '1.25px solid var(--surface-container-high)', background: 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))', cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start' }}>
      <Img src={image} w={55} h={55} />
      <span class="col" style={{ gap: '5px' }}>
        <span style={{ fontSize: '16px', fontWeight: 500, maxWidth: '220px' }}>{title}</span>
        <span class="muted" style={{ fontSize: '12px' }}>{description}</span>
      </span>
    </button>
  );
}

function RestoreOptionsPage({ args }: { args?: boolean }) {
  const dark = currentPalette().isDark;
  const sfx = dark ? '_dark' : '';
  const isNewInstall = args === true;
  return (
    <Page title={t('restore_restore_wallet')} legacy id="restore_options_page">
      <div class="col gap12" style={{ paddingTop: '24px' }}>
        <OptionTile id="restore_options_from_seeds_or_keys_button_key" image={`assets/images/restore_hot_wallet${sfx}.png`} title={t('restore_title_from_seed_keys')} description={t('restore_description_from_seed_keys')} onClick={() => nav.push(Routes.restoreWalletType)} />
        <OptionTile image={`assets/images/restore_hw${sfx}.png`} title={t('restore_title_from_hardware_wallet').trim()} description={t('restore_description_from_hardware_wallet')} onClick={() => nav.push(Routes.restoreWalletFromHardwareWallet)} />
        {isNewInstall && <OptionTile id="restore_options_from_backup_button_key" image={`assets/images/restore_backup${sfx}.png`} title={t('restore_title_from_backup')} description={t('restore_description_from_backup')} onClick={() => nav.push(Routes.restoreFromBackup)} />}
        <OptionTile image={`assets/images/restore_qr${sfx}.png`} title={t('scan_qr_code')} description={t('cold_or_recover_wallet')} onClick={async () => {
          const code = await nav.pushForResult<string>('/scan', { mode: 'restore' });
          if (code) await restoreFromQr(code);
        }} />
      </div>
    </Page>
  );
}

/** wallet_restore_from_qr_code.dart */
const QR_TYPES: [string, WalletType][] = [
  ['monero-wallet', 'monero'], ['monero_wallet', 'monero'], ['monero', 'monero'], ['bitcoin-wallet', 'bitcoin'], ['bitcoin_wallet', 'bitcoin'], ['bitcoin', 'bitcoin'],
  ['litecoin-wallet', 'litecoin'], ['litecoin_wallet', 'litecoin'], ['litecoin', 'litecoin'], ['ethereum-wallet', 'ethereum'], ['polygon-wallet', 'polygon'], ['base-wallet', 'base'],
  ['arbitrum-wallet', 'arbitrum'], ['bsc-wallet', 'bsc'], ['robinhood-wallet', 'robinhood'], ['nano-wallet', 'nano'], ['nano_wallet', 'nano'], ['bitcoincash-wallet', 'bitcoinCash'],
  ['bitcoincash_wallet', 'bitcoinCash'], ['bitcoincash', 'bitcoinCash'], ['solana-wallet', 'solana'], ['tron-wallet', 'tron'], ['tron_wallet', 'tron'], ['tron', 'tron'],
  ['decred-wallet', 'decred'], ['decred_wallet', 'decred'], ['decred', 'decred'], ['dogecoin-wallet', 'dogecoin'], ['dogecoin_wallet', 'dogecoin'], ['dogecoin', 'dogecoin'],
  ['zcash-wallet', 'zcash'], ['zcash_wallet', 'zcash'], ['zcash', 'zcash'],
];

async function restoreFromQr(raw: string) {
  const code = raw.replace(/^\[[^\]]*\]/, '').trim();
  const lower = code.toLowerCase();
  let type = QR_TYPES.filter(([k]) => lower.includes(k)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  if (!type && /^(xpub|zpub)/i.test(code)) type = 'bitcoin';
  if (!type) {
    await showAlert({ content: "Can't determine wallet type, please pick it manually" });
    nav.push(Routes.restoreWalletType);
    return;
  }
  const q = new URLSearchParams(code.slice(code.indexOf(':') + 1).replace(/^\?/, '').replace('?', '&'));
  const seed = q.get('mnemonic_seed') ?? q.get('seed') ?? q.get('hexSeed') ?? '';
  const keysMode = !!(q.get('spend_key') || q.get('view_key') || q.get('private_key') || q.get('xpub') || /^(xpub|zpub)/i.test(code));
  nav.push(Routes.restoreWallet, {
    walletType: type,
    prefill: { mode: keysMode ? 'keys' : 'seed', seed, passphrase: q.get('passphrase') ?? '', name: q.get('label') ?? '', address: q.get('address') ?? '', spendKey: q.get('spend_key') ?? '', viewKey: q.get('view_key') ?? q.get('xpub') ?? (/^(xpub|zpub)/i.test(code) ? code : ''), privateKey: q.get('private_key') ?? '', height: q.get('height') ?? '' },
  });
}

const HEIGHT_TYPES: WalletType[] = ['monero', 'wownero', 'zcash', 'zano'];

function hasKeysTab(type: WalletType): boolean {
  return !['bitcoinCash', 'dogecoin', 'zano'].includes(type);
}

function WalletRestorePage({ args }: { args: { walletType: WalletType; prefill?: any } }) {
  const type = args.walletType;
  const pre = args.prefill ?? {};
  const [mode, setMode] = useState<'seed' | 'keys'>(pre.mode ?? 'seed');
  const [name, setName] = useState(pre.name ?? '');
  const [seed, setSeed] = useState(pre.seed ?? '');
  const [height, setHeight] = useState(pre.height ?? '');
  const [date, setDate] = useState('');
  const [hasPass, setHasPass] = useState(!!pre.passphrase);
  const [passphrase, setPassphrase] = useState(pre.passphrase ?? '');
  const [address, setAddress] = useState(pre.address ?? '');
  const [viewKey, setViewKey] = useState(pre.viewKey ?? '');
  const [spendKey, setSpendKey] = useState(pre.spendKey ?? '');
  const [privateKey, setPrivateKey] = useState(pre.privateKey ?? '');
  const [busy, setBusy] = useState(false);
  const needsHeight = HEIGHT_TYPES.includes(type);
  const words = seed.trim() ? seed.trim().split(/\s+/) : [];
  const isPolyseed = type === 'monero' && (words.length === 16 || words.length === 14);
  const seedOk = (() => {
    if (!seed.trim()) return false;
    if (seed !== seed.trim() && !seed.endsWith(' ')) return false;
    const n = words.length;
    if (type === 'monero') return n === 25 || n === 16 || n === 14 || (n === 12 && !!height);
    if (type === 'decred') return [12, 15, 24].includes(n);
    return [12, 18, 24].includes(n);
  })();
  const keysOk = (() => {
    if (type === 'monero' || type === 'wownero') return !!address.trim() && !!viewKey.trim() && (!!height || true);
    if (type === 'bitcoin' || type === 'litecoin' || type === 'decred') return !!viewKey.trim();
    return !!privateKey.trim();
  })();
  const enabled = mode === 'seed' ? seedOk && (!needsHeight || isPolyseed || !!height || !!date) : keysOk;

  const restore = async (pass?: string) => {
    const n = name.trim();
    const err = validateWalletName(n);
    if (err) return showAlert({ title: t('restore_restore_wallet'), content: err });
    if (walletNameTaken(n)) return showAlert({ title: t('restore_restore_wallet'), content: t('wallet_name_exists') });
    setBusy(true);
    try {
      const h = height ? Number(height.replace(/[^0-9]/g, '')) : date ? estimateMoneroHeight(new Date(date)) : undefined;
      let info;
      if (mode === 'seed') {
        const m = words.join(' ').toLowerCase();
        const mod = await coinModule(type);
        let chosen: DerivationCandidate | undefined;
        if (mod.findDerivations && (type === 'bitcoin' || type === 'litecoin' || type === 'nano')) {
          const list = await mod.findDerivations(m, pass ?? '');
          const withHistory = list.filter((d) => (d.txCount ?? 0) > 0);
          const scanPaths = new Set(["m/84'/0'/0'", "m/86'/0'/0'", "m/44'/0'/0'", "m/49'/0'/0'"]);
          const skip = withHistory.length > 0 && withHistory.every((d) => scanPaths.has(d.derivationPath ?? ''));
          if (withHistory.length > 1 && !skip) chosen = await nav.pushForResult<DerivationCandidate>(Routes.restoreWalletChooseDerivation, { list });
          else if (withHistory.length === 1) chosen = withHistory[0];
          else if (list.length === 1) chosen = list[0];
        }
        info = await restoreWalletFromSeed(type, { name: n, mnemonic: m, passphrase: pass, height: h, derivationType: chosen?.derivationType, derivationPath: chosen?.derivationType === 'electrum' ? "m/0'" : chosen?.derivationPath });
      } else {
        info = await restoreWalletFromKeys(type, { name: n, address: address.trim(), viewKey: viewKey.trim(), spendKey: spendKey.trim(), privateKey: (privateKey || viewKey).trim(), hexSeed: privateKey.trim(), height: h });
      }
      await openWallet(info.id);
      nav.reset(Routes.dashboard);
    } catch (e) {
      await showAlert({ title: t('restore_restore_wallet'), content: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const keyFields = () => {
    if (type === 'monero' || type === 'wownero') {
      return (
        <>
          <Field value={address} onInput={setAddress} placeholder={t('restore_address')} multiline rows={2} mono id="restore_address" />
          <Field value={viewKey} onInput={setViewKey} placeholder={t('restore_view_key_private')} multiline rows={2} mono id="restore_view_key" />
          <Field value={spendKey} onInput={setSpendKey} placeholder={t('restore_spend_key_private')} multiline rows={2} mono id="restore_spend_key" />
        </>
      );
    }
    if (type === 'bitcoin' || type === 'decred' || type === 'litecoin') return <Field value={viewKey} onInput={setViewKey} placeholder={t('view_key_public') === 'view_key_public' ? 'View key (public)' : t('view_key_public')} multiline rows={3} mono id="restore_xpub" />;
    if (type === 'nano') return <Field value={privateKey} onInput={setPrivateKey} placeholder={t('seed_hex_form')} multiline rows={3} mono id="restore_private_key" />;
    return <Field value={privateKey} onInput={setPrivateKey} placeholder={t('private_key')} multiline rows={3} mono id="restore_private_key" />;
  };

  return (
    <Page
      title={mode === 'seed' ? t('restore_title_from_seed') : t('restore_title_from_keys')}
      legacy
      id="wallet_restore_page"
      footer={
        <>
          {mode === 'seed' && (
            <label class="rowx gap8" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={hasPass} onChange={(e) => setHasPass((e.target as HTMLInputElement).checked)} id="restore_has_passphrase" style={{ width: '20px', height: '20px', accentColor: 'var(--primary)' }} />
              <span>{t('wallet_has_passphrase')}</span>
            </label>
          )}
          <Button
            id="wallet_restore_seed_or_key_restore_button_key"
            disabled={!enabled}
            loading={busy}
            onClick={async () => {
              if (mode === 'seed' && hasPass) {
                const p = await askPassphrase(passphrase);
                if (p === undefined) return;
                setPassphrase(p);
                await restore(p);
              } else await restore();
            }}
          >
            {mode === 'seed' && hasPass ? t('add_passphrase') : t('restore_recover')}
          </Button>
        </>
      }
    >
      {hasKeysTab(type) && (
        <div class="rowx gap24" style={{ padding: '0 6px 12px' }}>
          {(['seed', 'keys'] as const).map((m) => (
            <button type="button" id={`restore_tab_${m}`} onClick={() => { setMode(m); setName(''); setHeight(''); setDate(''); }} style={{ background: 'none', border: 0, fontSize: '16px', fontWeight: 600, padding: '4px 0', color: mode === m ? 'var(--primary)' : 'color-mix(in srgb, var(--primary) 50%, transparent)', borderBottom: mode === m ? '2px solid var(--primary)' : '2px solid transparent', cursor: 'pointer' }}>
              {m === 'seed' ? t('widgets_seed') : t('keys')}
            </button>
          ))}
        </div>
      )}
      <div class="col" style={{ gap: '20px', paddingTop: '8px' }}>
        <Field value={name} onInput={setName} placeholder={t('wallet_name')} id="wallet_restore_name" error={name && validateWalletName(name) ? validateWalletName(name) : null} suffix={<button type="button" class="ficon" onClick={() => setName(generateName())} aria-label={t('generate_name')}><img src="./cake/images/refresh_icon.png" alt="" style={{ width: '16px', opacity: 0.7 }} /></button>} />
        {mode === 'seed' ? (
          <Field value={seed} onInput={setSeed} placeholder={t('enter_seed_phrase')} multiline rows={4} id="restore_seed" suffix={<button type="button" class="ficon" aria-label={t('paste')} onClick={async () => { try { setSeed((await navigator.clipboard.readText()).trim()); } catch { /* clipboard blocked */ } }}><img src="./cake/images/paste_ios.png" alt="" style={{ width: '18px' }} /></button>} hint={words.length ? `${words.length} ${t('words') === 'words' ? 'words' : t('words')}` : undefined} />
        ) : (
          keyFields()
        )}
        {needsHeight && !(mode === 'seed' && isPolyseed) && (
          <div class="col gap12">
            <Field value={height} onInput={(v) => setHeight(v.replace(/[^0-9]/g, ''))} placeholder={t('widgets_restore_from_blockheight')} inputMode="numeric" id="restore_height" />
            <div class="center muted">{t('widgets_or')}</div>
            <div class="field"><input type="date" value={date} min="2014-05-01" max={new Date().toISOString().slice(0, 10)} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setDate(v); if (v && type === 'monero') setHeight(String(estimateMoneroHeight(new Date(v)))); }} id="restore_date" aria-label={t('widgets_restore_from_date')} /></div>
            <div class="muted" style={{ fontSize: '12px' }}>{t('restore_from_date_or_blockheight')}</div>
          </div>
        )}
        {busy && <div class="rowx gap8 muted" style={{ justifyContent: 'center' }}><Spinner /> {t('restoring') === 'restoring' ? '' : t('restoring')}</div>}
      </div>
    </Page>
  );
}

function askPassphrase(initial: string): Promise<string | undefined> {
  return showSheet<string>((close) => <PassphraseSheet initial={initial} close={close} />);
}

function PassphraseSheet({ initial, close }: { initial: string; close: (v?: string) => void }) {
  const [p, setP] = useState(initial);
  const [c, setC] = useState(initial);
  const [show, setShow] = useState(false);
  const mismatch = p !== c;
  return (
    <div class="col gap12" style={{ padding: '24px 18px' }}>
      <div style={{ fontSize: '18px', fontWeight: 600, textAlign: 'center' }}>{t('add_passphrase')}</div>
      <Field value={p} onInput={setP} placeholder={t('passphrase')} type={show ? 'text' : 'password'} id="restore_passphrase" suffix={<button type="button" class="ficon" onClick={() => setShow(!show)}><MIcon name={show ? 'eyeOff' : 'eye'} size={20} /></button>} />
      <Field value={c} onInput={setC} placeholder={t('confirm_passphrase')} type={show ? 'text' : 'password'} error={mismatch && c ? t('passphrases_doesnt_match') : null} id="restore_passphrase_confirm" />
      <Button disabled={mismatch} id="restore_passphrase_continue" onClick={() => close(p)}>{t('restore_recover')}</Button>
    </div>
  );
}

function ChooseDerivationPage({ args }: { args: { list: DerivationCandidate[] } }) {
  return (
    <Page title={t('choose_derivation')} legacy id="choose_derivation_page">
      {args.list.length === 0 ? (
        <div class="empty">Error! No derivations available!</div>
      ) : (
        <div class="col gap12" style={{ paddingTop: '12px' }}>
          {args.list.map((d) => (
            <button type="button" onClick={() => nav.pop(d)} class="col" style={{ gap: '4px', background: 'var(--surface-container)', borderRadius: '18px', border: 0, padding: '16px', textAlign: 'start', color: 'var(--on-surface)', cursor: 'pointer' }}>
              <span style={{ fontSize: '16px', fontWeight: 600 }}>{d.description || d.derivationType}</span>
              {d.derivationPath && <span class="muted mono">{d.derivationPath}</span>}
              <span class="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>{d.address}</span>
              <span class="muted">Confirmed: {d.balance ?? '0'}</span>
              <span class="muted">Transactions: {d.txCount ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </Page>
  );
}

registerRoute(Routes.restoreOptions, RestoreOptionsPage);
registerRoute(Routes.restoreWallet, WalletRestorePage);
registerRoute(Routes.restoreWalletChooseDerivation, ChooseDerivationPage);
export { WALLET_TYPE_NAME, isEvm, pickOption };
