// Sign / Verify (lib/src/screens/dashboard/sign_page.dart, widgets/sign_form.dart,
// widgets/verify_form.dart, lib/view_model/dashboard/sign_view_model.dart), Rescan
// (lib/src/screens/rescan/rescan_page.dart) and the read-only Terms of Use
// (lib/src/screens/disclaimer/disclaimer_page.dart).

import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { Button, Field, Icon, Page, TopBar, copyText } from '../components/core.tsx';
import { showAlert, toast } from '../components/overlays.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { currentWallet } from '../../app/app.ts';
import { estimateMoneroHeight } from '../../coins/heights.ts';
import type { WalletBase } from '../../core/wallet.ts';

/** SignViewModel.signIncludesAddress */
const SIGN_WITH_ADDRESS = new Set(['monero', 'bitcoin', 'bitcoinCash', 'litecoin', 'dogecoin', 'haven']);

function PasteButton({ onPaste }: { onPaste: (v: string) => void }) {
  return (
    <button type="button" class="ficon" aria-label={t('paste')} onClick={async () => { try { onPaste((await navigator.clipboard.readText()).trim()); } catch { /* clipboard blocked */ } }}>
      <Icon src="paste.svg" size={20} />
    </button>
  );
}

function AddressPickerButton({ onPick }: { onPick: (v: string) => void }) {
  return (
    <button type="button" class="ficon" aria-label={t('addresses')} onClick={async () => { const a = await nav.pushForResult<string>(Routes.pickerWalletAddress); if (a) onPick(a); }}>
      <Icon src="contacts_outlined.svg" size={20} />
    </button>
  );
}

function SignPage() {
  const w = currentWallet.value;
  const [page, setPage] = useState(0);
  const [msg, setMsg] = useState('');
  const [addr, setAddr] = useState('');
  const [sig, setSig] = useState('');
  const [vMsg, setVMsg] = useState('');
  const [vAddr, setVAddr] = useState('');
  const [vSig, setVSig] = useState('');
  const [busy, setBusy] = useState(false);
  const pager = useRef<HTMLDivElement>(null);
  if (!w) return null;
  const withAddress = SIGN_WITH_ADDRESS.has(w.type);
  const go = (i: number) => {
    setPage(i);
    pager.current?.scrollTo({ left: i * pager.current.clientWidth, behavior: 'smooth' });
  };
  const confirm = async () => {
    setBusy(true);
    try {
      if (page === 0) {
        setSig(await w.signMessage(msg, withAddress ? addr.trim() || undefined : undefined));
      } else if (await w.verifyMessage(vMsg, vSig.trim(), vAddr.trim() || undefined)) {
        await showAlert({ title: t('successful'), content: t('message_verified'), right: t('ok') });
      } else {
        await showAlert({ title: t('error'), content: t('signature_invalid_error'), right: t('ok') });
      }
    } catch (e) {
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
    } finally {
      setBusy(false);
    }
  };
  const form = (children: preact.ComponentChildren) => <div class="col" style={{ gap: '20px', padding: '8px 24px', minWidth: '100%', boxSizing: 'border-box', scrollSnapAlign: 'start' }}>{children}</div>;
  return (
    <div class="page solid" id="sign_page">
      <TopBar title={t('sign_verify_title')} onBack={() => nav.pop()} />
      <div class="page-body" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
        <div ref={pager} class="rowx" style={{ alignItems: 'flex-start', overflowX: 'auto', scrollSnapType: 'x mandatory', scrollbarWidth: 'none', flex: 1 }} onScroll={(e) => { const el = e.currentTarget as HTMLDivElement; setPage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth))); }}>
          {form(
            <>
              <Field value={msg} onInput={setMsg} placeholder={t('message')} multiline rows={3} id="sign_message" suffix={<PasteButton onPaste={setMsg} />} />
              {withAddress && <Field value={addr} onInput={setAddr} placeholder={t('widgets_address')} multiline rows={2} mono id="sign_address" suffix={<span class="rowx" style={{ gap: '8px' }}><PasteButton onPaste={setAddr} /><AddressPickerButton onPick={setAddr} /></span>} />}
              <div onClick={() => sig && void copyText(sig)} style={{ cursor: sig ? 'pointer' : 'default' }}>
                <Field value={sig} onInput={() => {}} placeholder={t('signature')} multiline rows={3} mono readOnly id="sign_signature" />
              </div>
            </>,
          )}
          {form(
            <>
              <Field value={vMsg} onInput={setVMsg} placeholder={t('message')} multiline rows={3} id="verify_message" suffix={<PasteButton onPaste={setVMsg} />} />
              <Field value={vAddr} onInput={setVAddr} placeholder={t('widgets_address')} multiline rows={2} mono id="verify_address" suffix={<span class="rowx" style={{ gap: '8px' }}><PasteButton onPaste={setVAddr} /><AddressPickerButton onPick={setVAddr} /></span>} />
              <Field value={vSig} onInput={setVSig} placeholder={t('signature')} multiline rows={3} mono id="verify_signature" suffix={<PasteButton onPaste={setVSig} />} />
            </>,
          )}
        </div>
        <div class="rowx" style={{ justifyContent: 'center', gap: '6px', paddingTop: '10px' }}>
          {[0, 1].map((i) => <button type="button" aria-label={i ? t('verify_message') : t('sign_message')} onClick={() => go(i)} style={{ width: '6px', height: '6px', borderRadius: '6px', border: 0, padding: 0, cursor: 'pointer', background: page === i ? 'var(--outline)' : 'color-mix(in srgb, var(--outline) 50%, transparent)' }} />)}
        </div>
        <div style={{ padding: '20px 24px 24px' }}>
          <Button loading={busy} disabled={busy} id="sign_verify_button" onClick={() => void confirm()}>{page === 0 ? t('sign_message') : t('verify_message')}</Button>
        </div>
      </div>
    </div>
  );
}

/** the wallet's own (non-change) addresses; picking one returns it */
// ---------------------------------------------------------------- rescan --

/** BlockchainHeightWidget: a height, or a date turned into a height */
function RescanPage() {
  const w = currentWallet.value;
  const initial = (wallet: WalletBase | null) => (wallet?.type === 'monero' ? String(wallet.info.restoreHeight || wallet.height.value || '') : '');
  const [height, setHeight] = useState(() => initial(w));
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!height) setHeight(initial(w));
  }, [w?.id]);
  if (!w) return null;
  const rescan = async () => {
    const h = Number(height.replace(/[^0-9]/g, ''));
    setBusy(true);
    try {
      await w.rescan(h);
      nav.pop();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Page title={t('rescan')} legacy id="rescan_page" footer={<Button disabled={!height.trim()} loading={busy} id="rescan_button" onClick={() => void rescan()}>{t('rescan')}</Button>}>
      <div class="col gap12" style={{ paddingTop: '16px' }}>
        <Field value={height} onInput={(v) => setHeight(v.replace(/[^0-9]/g, ''))} placeholder={t('widgets_restore_from_blockheight')} inputMode="numeric" id="rescan_height" />
        <div class="center muted">{t('widgets_or')}</div>
        <div class="field">
          <input type="date" value={date} min="2014-05-01" max={today} aria-label={t('widgets_restore_from_date')} id="rescan_date" onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setDate(v);
            if (v && w.type === 'monero') setHeight(String(estimateMoneroHeight(new Date(v))));
          }} />
        </div>
        <div class="muted" style={{ fontSize: '12px' }}>{t('restore_from_date_or_blockheight')}</div>
      </div>
    </Page>
  );
}

// ------------------------------------------------------------ disclaimer --

function ReadDisclaimerPage() {
  const [text, setText] = useState('');
  useEffect(() => {
    void fetch('./cake/text/Terms_of_Use.txt', { credentials: 'same-origin' }).then((r) => r.text()).then(setText).catch(() => {});
  }, []);
  return (
    <Page title="Terms of Use" legacy id="disclaimer_page">
      <div class="col" style={{ paddingTop: '10px' }}>
        <div style={{ fontSize: '20px', fontWeight: 700, textAlign: 'center' }}>Terms and conditions</div>
        <div style={{ height: '20px' }} />
        <div style={{ fontSize: '12px', fontWeight: 700, textAlign: 'center', whiteSpace: 'pre-line' }}>{'Legal Disclaimer\nAnd\nTerms of Use'}</div>
        <div style={{ height: '16px' }} />
        <div style={{ fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: 1.45 }} id="disclaimer_text">{text}</div>
        <div style={{ height: '16px' }} />
      </div>
    </Page>
  );
}

registerRoute(Routes.signPage, SignPage);
registerRoute(Routes.rescan, RescanPage);
registerRoute(Routes.readDisclaimer, ReadDisclaimerPage);
