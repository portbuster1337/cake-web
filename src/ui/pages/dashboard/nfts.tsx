// NFTs (lib/src/screens/dashboard/pages/nft_listing_page.dart, nft_details_page.dart,
// nft_import_page.dart, nft_send_page.dart, widgets/nft_tile_widget.dart,
// widgets/solana_nft_tile_widget.dart): the home screen's NFTs tab, an NFT's
// details, importing one, and sending a Solana NFT. Pictures and metadata come
// over Tor like everything else.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../../core/i18n.ts';
import { Button, Field, Icon, MIcon, Page, Spinner } from '../../components/core.tsx';
import { confirmAlert, showAlert, showSheet, toast } from '../../components/overlays.tsx';
import { torImageUrl } from '../../components/remoteImg.tsx';
import { requireAuth } from '../../components/auth.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet } from '../../../app/app.ts';
import { formatFixed } from '../../../core/amount.ts';
import type { PendingTransaction, WalletBase } from '../../../core/wallet.ts';
import { cutDigits } from '../../../buy/format.ts';
import { nftImageUrl, type NftAsset, type SolanaNft } from '../../../nft/models.ts';
import { nftViewModel, type SolanaNftWallet } from '../../../nft/nfts.ts';
import { sendNeedsTotp } from '../send.tsx';

/** NFT art is larger than logos */
const NFT_IMAGE_MAX = 8 * 1024 * 1024;
const scopeOf = (w: WalletBase) => `wallet:${w.id}`;
const tileId = (s: string | null) => (s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);

/** BottomSheetMessageDisplayWidget: "Error" (or "Successful"), a close button, the message */
function messageSheet(message: string, isError = true): Promise<void> {
  return showSheet<void>((close) => (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '18px 18px 0 0', padding: '16px 24px 0' }} id="nft_message_sheet">
      <div class="rowx" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: '16px', color: 'var(--on-surface-variant)' }}>{isError ? t('error') : t('successful')}</span>
        <button type="button" class="ficon" aria-label={t('close')} onClick={() => close()}><MIcon name="close" size={22} color="var(--on-surface-variant)" /></button>
      </div>
      <div style={{ height: '8px' }} />
      <div style={{ color: 'var(--on-surface-variant)' }} id="nft_message">{message}</div>
      <div style={{ height: '16px' }} />
    </div>
  )).then(() => {});
}

nftViewModel.onError = (m) => void messageSheet(m);

/** CakeImageWidget for NFT art: a spinner while it comes over Tor, the picture cover-cropped, else the error placeholder */
function NftImage({ url, scope }: { url: string | null; scope: string }) {
  const [state, setState] = useState<{ src: string | null; done: boolean }>({ src: null, done: !url });
  useEffect(() => {
    if (!url) {
      setState({ src: null, done: true });
      return;
    }
    let live = true;
    setState({ src: null, done: false });
    void torImageUrl(url, NFT_IMAGE_MAX, scope).then((src) => live && setState({ src, done: true }));
    return () => {
      live = false;
    };
  }, [url]);
  const box = { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' };
  if (!state.done) return <span style={box}><Spinner /></span>;
  if (!state.src) return <span style={{ ...box, background: 'var(--surface-container-highest)' }} class="nft-image-error"><MIcon name="error_outline" size={24} color="var(--on-surface-variant)" /></span>;
  return <img src={state.src} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: url!.toLowerCase().endsWith('.svg') ? 'contain' : 'cover', display: 'block' }} />;
}

const thumb = (child: ComponentChildren) => (
  <span style={{ width: '100px', height: '100px', margin: '8px', borderRadius: '24px', border: '0.5px solid var(--outline)', background: 'var(--surface)', overflow: 'hidden', flex: 'none', display: 'flex' }}>{child}</span>
);

/** NFTTileWidget */
function NftTile({ a, scope }: { a: NftAsset; scope: string }) {
  return (
    <button type="button" class="rowx" id={`nft_tile_${tileId(a.tokenAddress)}_${tileId(a.tokenId)}`} onClick={() => nav.push(Routes.nftDetailsPage, { evm: a })} style={{ width: '100%', border: '0.5px solid var(--outline)', borderRadius: '30px', background: 'var(--surface-container)', padding: 0, cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start' }}>
      {thumb(<NftImage url={nftImageUrl(a)} scope={scope} />)}
      <span class="col grow" style={{ minWidth: 0, gap: '8px', paddingRight: '12px' }}>
        <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)', lineHeight: 1 }}>{`${a.name ?? '---'} - ${a.symbol ?? '---'}`}</span>
        <span style={{ fontSize: '22px', fontWeight: 900, lineHeight: 1, overflowWrap: 'anywhere' }}>{a.normalizedMetadata?.name ?? a.name ?? '---'}</span>
      </span>
    </button>
  );
}

/** SolanaNFTTileWidget: "View only" when the wallet does not hold it; a sent NFT leaves the list */
function SolanaNftTile({ a, w }: { a: SolanaNft; w: WalletBase }) {
  const open = async () => {
    const walletId = w.id;
    const sent = await nav.pushForResult<boolean>(Routes.nftDetailsPage, { solana: a });
    if (sent === true && a.mint) await nftViewModel.onNftSent(walletId, a.mint);
  };
  return (
    <button type="button" class="rowx" id={`nft_tile_${tileId(a.mint)}`} onClick={() => void open()} style={{ width: '100%', border: '0.5px solid var(--outline)', borderRadius: '16px', background: 'var(--surface-container)', padding: '8px', cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start' }}>
      {thumb(<NftImage url={a.imageOriginalUrl} scope={scopeOf(w)} />)}
      <span class="col grow" style={{ minWidth: 0, gap: '8px', paddingRight: '8px' }}>
        <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)', lineHeight: 1 }}>{`Symbol: ${a.symbol ?? '---'}`}</span>
        <span style={{ fontSize: '22px', fontWeight: 900, lineHeight: 1, overflowWrap: 'anywhere' }}>{a.name ? a.name : a.symbol ?? '---'}</span>
        {a.isOwned === false && (
          <span style={{ alignSelf: 'flex-start', padding: '4px 8px', borderRadius: '8px', background: 'var(--surface-container-highest)', color: 'var(--on-surface-variant)', fontSize: '12px', fontWeight: 600, lineHeight: 1 }} class="nft-watching">{t('watching')}</span>
        )}
      </span>
    </button>
  );
}

/** NFTListingPage: the NFTs tab (Import, "some could not be loaded", the list) */
export function NftListing({ w }: { w: WalletBase }) {
  const vm = nftViewModel;
  useEffect(() => {
    void vm.load(w);
  }, [w.id]);
  const solana = w.type === 'solana';
  const list = solana ? vm.solanaAssets.value : vm.evmAssets.value;
  return (
    <div class="col" id="nft_listing">
      <div style={{ padding: '16px 0' }}>
        <Button secondary id="nft_import" style={{ color: 'var(--on-secondary-container)' }} onClick={() => nav.push(Routes.importNFTPage)}>{t('import')}</Button>
      </div>
      {vm.unresolvedCount.value > 0 && <div class="muted center" style={{ fontSize: '12px', padding: '0 16px 12px' }} id="nft_some_not_loaded">{t('nft_some_not_loaded')}</div>}
      {vm.isLoading.value ? (
        <div class="center" style={{ padding: '8px 0 64px' }} id="nft_loading"><Spinner large /></div>
      ) : !list.length ? (
        <div class="col" style={{ alignItems: 'center', gap: '12px', padding: '8px 16px 64px' }}>
          <div class="muted center" style={{ fontSize: '16px' }} id="nft_empty">{t('noNFTYet')}</div>
          {vm.source.value === 'none' && <div class="muted center" style={{ fontSize: '12px' }} id="nft_needs_key">This chain's NFTs are listed with a Moralis API key (Settings → Connection and sync → API keys). Imported NFTs show here without one.</div>}
        </div>
      ) : (
        <div class="col" style={{ gap: '8px', padding: '16px 4px 64px' }} id="nft_list">
          {solana ? vm.solanaAssets.value.map((a) => <SolanaNftTile a={a} w={w} />) : vm.evmAssets.value.map((a) => <NftTile a={a} scope={scopeOf(w)} />)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- details --

/** _NFTSingleInfoTile */
function InfoTile({ label, value, id }: { label: string; value: string; id?: string }) {
  return (
    <div class="col" style={{ padding: '0 24px', gap: '8px' }} id={id}>
      <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--on-surface-variant)', lineHeight: 1 }}>{label}</span>
      <span style={{ fontSize: '16px', fontWeight: 600, lineHeight: 1.25, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{value}</span>
    </div>
  );
}

const gap = (h: number) => <div style={{ height: `${h}px`, flex: 'none' }} />;

/** _NFTImageWidget */
function BigImage({ url, scope }: { url: string | null; scope: string }) {
  return (
    <div style={{ height: '40vh', margin: '8px', borderRadius: '24px', border: '1px solid var(--outline)', background: 'var(--surface)', overflow: 'hidden', display: 'flex' }} id="nft_details_image">
      <NftImage url={url} scope={scope} />
    </div>
  );
}

/** _NFTMoreInfoSection: Show Details / Hide Details */
function MoreInfo({ entries }: { entries: [string, string][] }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="col">
      {gap(8)}
      <button type="button" id="nft_more_info" onClick={() => setOpen(!open)} class="rowx" style={{ justifyContent: 'space-between', padding: '12px 24px', border: 0, background: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '16px', fontWeight: 600 }}>
        <span>{open ? t('hide_details') : t('show_details')}</span>
        <MIcon name="chevronDown" size={24} color="var(--primary)" style={open ? { transform: 'rotate(180deg)' } : undefined} />
      </button>
      {open && entries.map(([k, v]) => (
        <>
          {gap(16)}
          <InfoTile label={k} value={v} />
        </>
      ))}
    </div>
  );
}

function DetailsPage({ args }: { args: { evm?: NftAsset; solana?: SolanaNft } }) {
  const w = currentWallet.value;
  if (!w) return null;
  const scope = scopeOf(w);
  const s = args.solana;
  const e = args.evm;
  // _canSend
  const canSend = !!s && !!s.mint && s.isOwned !== false;
  let body: ComponentChildren;
  if (s) {
    const more = ([
      [t('mint_address'), s.mint ?? ''],
      [t('contractName'), s.contract?.name ?? ''],
      [t('contractSymbol'), s.contract?.symbol ?? ''],
      [t('collection_name'), s.collection?.name ?? ''],
      [t('collection_description'), s.collection?.description ?? ''],
      [t('collection_address'), s.collection?.collectionAddress ?? ''],
    ] as [string, string][]).filter(([, v]) => v);
    body = (
      <div class="col">
        <BigImage url={s.imageOriginalUrl} scope={scope} />
        {gap(16)}
        <InfoTile label={t('name')} value={s.name ?? '---'} id="nft_details_name" />
        {s.isOwned === false && (
          <>
            {gap(16)}
            <InfoTile label={t('watching')} value={t('nft_not_held_by_wallet')} id="nft_details_watching" />
          </>
        )}
        {!!s.description && (
          <>
            {gap(16)}
            <InfoTile label={t('description')} value={s.description} id="nft_details_description" />
          </>
        )}
        {more.length > 0 && <MoreInfo entries={more} />}
        {gap(16)}
      </div>
    );
  } else if (e) {
    const m = e.normalizedMetadata;
    body = (
      <div class="col">
        <BigImage url={nftImageUrl(e)} scope={scope} />
        {gap(16)}
        <InfoTile label={t('name')} value={m?.name ?? '---'} id="nft_details_name" />
        {m?.description != null && (
          <>
            {gap(16)}
            <InfoTile label={t('description')} value={m.description ?? '---'} id="nft_details_description" />
          </>
        )}
        {gap(16)}
        <InfoTile label={t('contractName')} value={e.name ?? '---'} id="nft_details_contract_name" />
        {gap(8)}
        <InfoTile label={t('contractSymbol')} value={e.symbol ?? '---'} id="nft_details_contract_symbol" />
        {gap(16)}
      </div>
    );
  } else body = <div class="center" style={{ padding: '24px' }}>{t('no_extra_detail')}</div>;
  return (
    <Page legacy id="nft_details_page" bodyClass="">
      <div class="col">
        <div style={{ margin: '16px', borderRadius: '24px', border: '1px solid var(--outline)', background: 'var(--surface)', overflow: 'hidden' }}>{body}</div>
        {canSend && (
          <div style={{ padding: '0 16px 24px' }}>
            <Button id="nft_send" onClick={async () => {
              const sent = await nav.pushForResult<boolean>(Routes.nftSendPage, { asset: s });
              if (sent === true) nav.pop(true);
            }}>{t('send')}</Button>
          </div>
        )}
      </div>
    </Page>
  );
}

// -------------------------------------------------------------- import --

function pasteInto(set: (v: string) => void) {
  return (
    <button type="button" class="ficon" aria-label={t('paste')} onClick={async () => {
      try {
        const v = (await navigator.clipboard.readText()).trim();
        if (v) set(v);
      } catch { /* clipboard blocked */ }
    }}><Icon src="paste.svg" size={20} color="var(--primary)" /></button>
  );
}

/** ImportNFTPage: the address (a mint on Solana) and, on EVM chains, the token ID */
function ImportPage() {
  const w = currentWallet.value;
  const [address, setAddress] = useState('');
  const [tokenId, setTokenId] = useState('');
  const vm = nftViewModel;
  if (!w) return null;
  const solana = w.type === 'solana';
  const label = (s: string) => <span style={{ fontSize: '16px', fontWeight: 600 }}>{s}</span>;
  return (
    <Page
      title={t('import')}
      solid
      id="import_nft_page"
      footer={<Button id="nft_import_confirm" loading={vm.isImportLoading.value} onClick={async () => {
        await vm.importNft(address, tokenId);
        if (nav.top?.name === Routes.importNFTPage) nav.pop();
      }}>{t('import')}</Button>}
    >
      <div class="col" style={{ paddingTop: '16px' }}>
        {label(t('address'))}
        {gap(8)}
        <Field id="nft_import_address" value={address} onInput={setAddress} placeholder={solana ? t('mint_address') : '0x...'} mono suffix={pasteInto(setAddress)} />
        {!solana && (
          <>
            {gap(48)}
            {label(t('tokenID'))}
            {gap(8)}
            <Field id="nft_import_token_id" value={tokenId} onInput={setTokenId} placeholder={t('enterTokenID')} inputMode="numeric" suffix={pasteInto(setTokenId)} />
          </>
        )}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------- send --

/** _NFTSendConfirmation */
function SendConfirmation({ name, mint, to, fee, creation }: { name: string | null; mint: string | null; to: string; fee: string; creation: string | null }) {
  const row = (label: string, value: string, id: string) => (
    <div class="col" style={{ gap: '2px', textAlign: 'center' }} id={id}>
      <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{label}</span>
      <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
  return (
    <div class="col" style={{ gap: '12px' }} id="nft_send_confirmation">
      {!!name && row(t('name'), name, 'nft_confirm_name')}
      {!!mint && row(t('mint_address'), mint, 'nft_confirm_mint')}
      {row(t('address'), to, 'nft_confirm_address')}
      {row(t('send_estimated_fee'), fee, 'nft_confirm_fee')}
      {creation && <div style={{ fontSize: '12px', textAlign: 'center', color: 'var(--on-surface-variant)' }} id="nft_confirm_creation">{t('recipient_account_creation_fee', { amount: creation })}</div>}
    </div>
  );
}

/** a scanned or pasted solana: link's address */
const solanaAddressOf = (v: string) => v.trim().replace(/^solana:/i, '').split('?')[0];

/** NFTSendPage: a recipient, then the PIN (and 2FA by recipient), the confirmation, the send */
function SendPage({ args }: { args: { asset: SolanaNft } }) {
  const w = currentWallet.value as SolanaNftWallet | null;
  const a = args.asset;
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!w || w.type !== 'solana' || !a?.mint) return null;

  const onSend = async () => {
    if (busy) return;
    const dest = to.trim();
    // AddressValidator(type: CryptoCurrency.sol)
    if (!dest || !w.validateAddress(dest)) {
      setError(t('error_text_address'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (!(await requireAuth({ totp: sendNeedsTotp([dest]) }))) return;
      let pending: PendingTransaction;
      try {
        pending = await w.createNftTransaction(a.mint!, dest, { name: a.name ?? undefined });
      } catch (e) {
        await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
        return;
      }
      const creation = pending.additionalCost !== undefined ? `${cutDigits(formatFixed(pending.additionalCost, 9), 8)} SOL` : null;
      const ok = await confirmAlert(t('confirm_sending'), <SendConfirmation name={a.name} mint={a.mint} to={dest} fee={pending.feeFormatted} creation={creation} />, t('send'), t('cancel'));
      if (!ok) return;
      try {
        await pending.commit();
      } catch (e) {
        await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
        return;
      }
      await showAlert({ content: t('transaction_sent'), right: t('ok') });
      nav.pop(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={t('send')} legacy id="nft_send_page" bodyClass="">
      <div class="col" style={{ padding: '16px' }}>
        <div style={{ height: '28vh', borderRadius: '24px', overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--outline)', display: 'flex' }}>
          <NftImage url={a.imageOriginalUrl} scope={scopeOf(w)} />
        </div>
        {gap(16)}
        <div class="center" style={{ fontSize: '22px', fontWeight: 700, overflowWrap: 'anywhere' }} id="nft_send_name">{a.name ? a.name : a.symbol ?? '---'}</div>
        {gap(24)}
        <div class="rowx" style={{ padding: '4px 4px 4px 16px', borderRadius: '16px', background: 'var(--surface-container)', gap: '8px', border: error ? '1px solid var(--error)' : '1px solid transparent' }}>
          <input id="nft_send_address" value={to} placeholder={t('recipient_address')} spellcheck={false} autoComplete="off" onInput={(e) => setTo((e.target as HTMLInputElement).value)} style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 0, color: 'var(--on-surface)', fontSize: '16px', padding: '12px 0', fontFamily: 'inherit' }} />
          <button type="button" class="ficon" aria-label={t('paste')} id="nft_send_paste" onClick={async () => {
            try {
              setTo(solanaAddressOf(await navigator.clipboard.readText()));
            } catch {
              toast(t('paste'));
            }
          }}><Icon src="paste.svg" size={22} /></button>
          <button type="button" class="ficon" aria-label={t('scan')} onClick={async () => {
            const v = await nav.pushForResult<string>('/scan', { mode: 'address' });
            if (v) setTo(solanaAddressOf(v));
          }}><Icon src="scan.svg" size={22} /></button>
        </div>
        {error && <div class="field-error" id="nft_send_error">{error}</div>}
        {gap(24)}
        <Button id="nft_send_confirm" loading={busy} onClick={() => void onSend()}>{t('send')}</Button>
      </div>
    </Page>
  );
}

registerRoute(Routes.nftDetailsPage, DetailsPage);
registerRoute(Routes.importNFTPage, ImportPage);
registerRoute(Routes.nftSendPage, SendPage);
