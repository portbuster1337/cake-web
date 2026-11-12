// Coin control (lib/new-ui/pages/coin_control_page.dart) + unspent coin details,
// and the QR scanner (lib/new-ui/pages/scan_page.dart) using the camera
// (BarcodeDetector when available, else jsQR on canvas frames).

import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { Button, Field, Icon, MIcon, ModernButton, Page, Row, Section, Spinner, ToggleRow, TopBar } from '../components/core.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { currentWallet } from '../../app/app.ts';
import { formatFixed } from '../../core/amount.ts';
import { apiString, fiatValue, formatFiatAmount } from '../../app/prices.ts';
import { settings } from '../../app/settings.ts';
import { ModalHeader } from './settings/main.tsx';
import { openExternal } from './dashboard/history.tsx';
import { parsePaymentRequest } from '../../core/paymentUri.ts';

function short(a: string) {
  return a.length > 14 ? `${a.slice(0, 5)}...${a.slice(-5)}` : a;
}

function CoinControlPage({ args }: { args?: { canEdit?: boolean; selected?: string[] } }) {
  const w = currentWallet.value as any;
  const canEdit = !!args?.canEdit;
  const [sel, setSel] = useState<Set<string>>(new Set(args?.selected ?? []));
  if (!w || !w.unspents) return null;
  const list: any[] = w.unspents.value;
  const unfrozen = list.filter((u) => !u.frozen);
  const frozen = list.filter((u) => u.frozen);
  const op = (u: any) => `${u.txid}:${u.vout}`;
  const RowU = ({ u, first, last }: { u: any; first: boolean; last: boolean }) => {
    const f = fiatValue(Number(formatFixed(u.value, w.currency.decimals)), apiString(w.currency));
    return (
      <div class="rowx" style={{ height: '70px', background: 'var(--surface-container)', padding: '0 12px', gap: '12px', borderTopLeftRadius: first ? '12px' : 0, borderTopRightRadius: first ? '12px' : 0, borderBottomLeftRadius: last ? '12px' : 0, borderBottomRightRadius: last ? '12px' : 0, borderTop: first ? 0 : '1px solid var(--surface-container-high)', cursor: 'pointer' }} onClick={() => nav.push(Routes.unspentCoinsDetails, { outpoint: op(u) })} id={`utxo_${u.txid.slice(0, 8)}_${u.vout}`}>
        {u.frozen ? (
          <Icon src="frozen.svg" size={24} color="var(--on-surface-variant)" />
        ) : canEdit ? (
          <span class={`check${sel.has(op(u)) ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); const n = new Set(sel); n.has(op(u)) ? n.delete(op(u)) : n.add(op(u)); setSel(n); }}>{sel.has(op(u)) && <MIcon name="check" size={18} />}</span>
        ) : null}
        <span class="col grow">
          <span>{formatFixed(u.value, w.currency.decimals)} {w.currency.title}</span>
          <span class="muted mono" style={{ fontSize: '12px' }}>{short(u.address)}</span>
        </span>
        {f !== null && settings.value.fiatApiMode !== 'disabled' && <span class="muted">{formatFiatAmount(f)} {settings.value.fiatCurrency}</span>}
        <Icon src="arrow_right.svg" w={7} h={12} color="var(--on-surface-variant)" />
      </div>
    );
  };
  return (
    <div class="page solid" id="coin_control_page">
      <TopBar onBack={() => nav.pop(canEdit ? [...sel] : undefined)} trailing={canEdit ? <button type="button" class="pill" style={{ color: 'var(--primary)', fontWeight: 600 }} id="coin_control_done" onClick={() => nav.pop([...sel])}>{t('done')}</button> : undefined} />
      <div class="page-body" style={{ padding: '0 18px 24px' }}>
        <ModalHeader icon="assets/new-ui/settings_row_icons/coin-control.svg" title="Coin Control" message={canEdit ? t('coin_control_desc') : t('coin_control_desc_no_edit')} />
        {canEdit && (
          <div class="rowx" style={{ gap: '20px', padding: '0 0 12px' }}>
            <button type="button" class="link-btn" style={{ width: 'auto', minHeight: 0, fontWeight: 400 }} onClick={() => setSel(new Set(unfrozen.map(op)))}>{t('select_all')}</button>
            <button type="button" class="link-btn" style={{ width: 'auto', minHeight: 0, fontWeight: 400 }} onClick={() => setSel(new Set())}>{t('unselect_all')}</button>
          </div>
        )}
        {!list.length && <div class="empty">{t('no_unspent_coins')}</div>}
        <div>{unfrozen.map((u, i) => <RowU u={u} first={i === 0} last={i === unfrozen.length - 1} />)}</div>
        {frozen.length > 0 && (
          <>
            <div class="muted" style={{ margin: '12px 0 8px' }}>{t('frozen')}</div>
            <div>{frozen.map((u, i) => <RowU u={u} first={i === 0} last={i === frozen.length - 1} />)}</div>
          </>
        )}
      </div>
    </div>
  );
}

function UnspentDetailsPage({ args }: { args: { outpoint: string } }) {
  const w = currentWallet.value as any;
  const u = w?.unspents?.value.find((x: any) => `${x.txid}:${x.vout}` === args.outpoint);
  const [note, setNote] = useState(u?.note ?? '');
  if (!w || !u) return null;
  const explorer = w.type === 'bitcoin' ? `https://ordinals.com/tx/${u.txid}` : w.type === 'dogecoin' ? `https://dogechain.info/tx/${u.txid}` : w.explorerUrl(u.txid);
  return (
    <Page title={t('unspent_coins_details_title')} solid id="unspent_details_page">
      <div class="col gap16">
        <Section>
          <Row label={t('transaction_details_amount')} trailingText={`${formatFixed(u.value, w.currency.decimals)} ${w.currency.title}`} />
          <Row label={t('transaction_details_transaction_id')} subtitle={<span class="mono" style={{ fontSize: '12px' }}>{u.txid}</span>} copy={u.txid} />
          <Row label={t('widgets_address')} subtitle={<span class="mono" style={{ fontSize: '12px' }}>{u.address}</span>} copy={u.address} />
        </Section>
        <Field label={t('note_tap_to_change')} value={note} onInput={setNote} placeholder={t('note')} />
        <Section>
          <ToggleRow label={t('freeze')} value={u.frozen} id="utxo_freeze" onChange={(v) => void w.setFrozen(args.outpoint, v)} />
          <Row label={t('view_in_block_explorer')} onClick={() => openExternal(explorer)} />
        </Section>
        <Button onClick={async () => { await w.setUtxoNote(args.outpoint, note); nav.pop(); }}>{t('save')}</Button>
      </div>
    </Page>
  );
}

// ------------------------------------------------------------------ scan --

function ScanPage({ args }: { args?: { mode?: string } }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [text, setText] = useState('');
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [camIdx, setCamIdx] = useState(0);
  const done = (v: string) => {
    if (args?.mode === 'home') {
      nav.pop();
      handleScanned(v);
    } else nav.pop(v);
  };
  useEffect(() => {
    if (manual) return;
    let stream: MediaStream | null = null;
    let stop = false;
    let raf = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: cams[camIdx] ? { deviceId: { exact: cams[camIdx].deviceId } } : { facingMode: 'environment' }, audio: false });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        if (!cams.length) setCams((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'));
        const BD = (globalThis as any).BarcodeDetector;
        const detector = BD ? new BD({ formats: ['qr_code'] }) : null;
        const jsqr = detector ? null : (await import('jsqr')).default;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const tick = async () => {
          if (stop || !video.current) return;
          const v = video.current;
          if (v.readyState >= 2) {
            try {
              if (detector) {
                const r = await detector.detect(v);
                if (r[0]?.rawValue) return done(r[0].rawValue);
              } else if (jsqr) {
                canvas.width = v.videoWidth;
                canvas.height = v.videoHeight;
                ctx.drawImage(v, 0, 0);
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = jsqr(img.data, img.width, img.height);
                if (code?.data) return done(code.data);
              }
            } catch { /* next frame */ }
          }
          raf = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch (e) {
        setErr((e as Error).message || 'Camera unavailable');
      }
    })();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [manual, camIdx]);
  return (
    <div class="page" style={{ background: '#000' }} id="scan_page">
      {!manual && <video ref={video} playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '80%', aspectRatio: '1', borderRadius: '24px', border: '4px solid #fff', boxShadow: '0 0 0 2000px rgba(0,0,0,.6)' }} />
      </div>
      <div class="rowx" style={{ position: 'absolute', top: '18px', left: '18px', right: '18px', justifyContent: 'space-between' }}>
        <div class="rowx gap24">
          <ModernButton icon="back" size={36} iconSize={18} bg="rgba(255,255,255,.4)" color="#fff" onClick={() => nav.pop()} />
          <span style={{ color: '#fff', fontSize: '18px', fontWeight: 600 }}>{t('scan')}</span>
        </div>
        {cams.length > 1 && <ModernButton svg="camera_flip.svg" size={36} bg="rgba(255,255,255,.4)" color="#fff" onClick={() => setCamIdx((camIdx + 1) % cams.length)} />}
      </div>
      {err && !manual && <div class="error-box" style={{ position: 'absolute', top: '80px', left: '16px', right: '16px' }}>{err}</div>}
      {manual ? (
        <div style={{ position: 'absolute', left: '16px', right: '16px', bottom: '40px' }} class="col gap12">
          <Field value={text} onInput={setText} placeholder={t('enter_code')} multiline rows={3} id="scan_manual_input" autoFocus />
          <Button disabled={!text.trim()} onClick={() => done(text.trim())} id="scan_manual_submit">{t('continue_text')}</Button>
        </div>
      ) : (
        <div class="rowx" style={{ position: 'absolute', bottom: '120px', left: 0, right: 0, justifyContent: 'center' }}>
          <button type="button" class="rowx gap8" id="scan_manual" onClick={() => setManual(true)} style={{ background: 'rgba(255,255,255,.4)', border: 0, borderRadius: '999px', padding: '10px 20px 10px 16px', color: '#fff', fontSize: '16px', fontWeight: 500, cursor: 'pointer' }}>
            <MIcon name="edit" size={28} color="#fff" /> {t('manual_input')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Dashboard Scan button routing (coin_action_row.dart): payment request → Send; node URL → New node */
function handleScanned(v: string) {
  const s = v.trim();
  if (/^wc:/i.test(s)) return nav.push(Routes.walletConnectConnectionsListing, { uri: s });
  if (/^(https?|tcp):\/\//i.test(s) && !/lnurl/i.test(s)) return nav.push(Routes.newNode, { type: currentWallet.value?.type, prefill: s });
  const pr = parsePaymentRequest(s);
  nav.push(Routes.send, { address: pr.address, amount: pr.amount, note: pr.note });
}

registerRoute(Routes.unspentCoinsList, CoinControlPage);
registerRoute(Routes.unspentCoinsDetails, UnspentDetailsPage);
registerRoute('/scan', ScanPage);
export { Spinner };
