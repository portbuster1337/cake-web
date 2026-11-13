// Bridge (lib/new-ui/pages/bridge/*, lib/new-ui/widgets/bridge/*,
// lib/view_model/bridge/*): USDT across Ethereum, Polygon and Arbitrum as
// USDT0 over LayerZero — the amount, the destination network, the receiving
// wallet (or an address), the confirmation with LayerZero's fee and a swipe,
// then the transfer's history and details.

import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../../core/i18n.ts';
import { Button, Icon, Img, MIcon, ModernButton, Page, Spinner, TopBar, copyText } from '../../components/core.tsx';
import { showSheet } from '../../components/overlays.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet, walletInfos } from '../../../app/app.ts';
import { settings } from '../../../app/settings.ts';
import { apiString, fiatValue, formatFiatAmount, prices, watchPrice } from '../../../app/prices.ts';
import { walletGroupKey } from '../../../app/groups.ts';
import { formatFixed, tryParseFixed } from '../../../core/amount.ts';
import { chainById } from '../../../coins/evm/chains.ts';
import { isValidEvmAddress } from '../../../coins/evm/eth.ts';
import type { TokenAsset } from '../../../coins/tokens.ts';
import type { WalletBase } from '../../../core/wallet.ts';
import { ConfirmSwiper } from '../send.tsx';
import { openExternal } from '../dashboard/history.tsx';
import { executeUsdt0, quoteUsdt0, usdt0DestinationChains, type MessagingFee, type Usdt0Wallet } from '../../../integrations/usdt0.ts';
import { addBridgeTransfer, bridgeStatusLabel, bridgeTransfers, isActive, pollBridgeTransfer, resumeBridgePolling, type BridgeTransfer, type ReceiptWallet } from '../../../integrations/bridge.ts';

type BridgeWallet = WalletBase & Usdt0Wallet & ReceiptWallet & { chainId: number };

const chainName = (id: number) => chainById(id)?.name ?? String(id);
const capitalized = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const fullIcon = (id: number) => `assets/new-ui/crypto_full_icons/${chainName(id).toLowerCase()}.svg`;
const badge = (type: string) => `assets/new-ui/chain_badges/${type.toLowerCase()}.svg`;
/** withMaxDecimals(8) */
const max8 = (s: string) => (s.includes('.') ? s.replace(/^(\d+\.\d{0,8}).*$/, '$1').replace(/\.$/, '') : s);

/** BridgeViewModel */
class BridgeVM {
  readonly wallet: BridgeWallet;
  readonly token: TokenAsset;
  readonly amount = signal('');
  readonly destinationChainId = signal<number | null>(null);
  readonly recipientAddress = signal('');
  readonly destinationWalletName = signal<string | null>(null);
  readonly quote = signal<MessagingFee | null>(null);
  readonly isQuoteLoading = signal(false);
  readonly quoteError = signal<string | null>(null);
  readonly isExecuting = signal(false);
  readonly executeError = signal<string | null>(null);
  readonly bridgeSuccess = signal(false);

  constructor(w: BridgeWallet, token: TokenAsset) {
    this.wallet = w;
    this.token = token;
  }

  get sourceChainId(): number {
    return this.wallet.chainId;
  }

  get availableDestinationChains(): number[] {
    return usdt0DestinationChains(this.sourceChainId);
  }

  /** the token's balance now (the wallet's balances move while the pages are open) */
  get balance(): bigint {
    return this.wallet.balances.value[this.token.key]?.available ?? this.token.balance;
  }

  get parsedAmount(): bigint | null {
    return tryParseFixed(this.amount.value.replace(',', '.'), this.token.decimals);
  }

  get amountError(): string | null {
    const a = this.parsedAmount;
    if (a === null || a === 0n) return null;
    return a > this.balance ? `Insufficient balance for ${this.token.symbol} token.` : null;
  }

  get canProceedToDestinationNetwork(): boolean {
    const a = this.parsedAmount;
    return !!this.amount.value && this.amountError === null && a !== null && a > 0n;
  }

  fiatOf(amount: string): string {
    const n = Number(amount.replace(',', '.'));
    const f = Number.isFinite(n) ? fiatValue(n, this.token.api) : null;
    return f === null ? '' : formatFiatAmount(f);
  }

  get feeLine(): string {
    const q = this.quote.value;
    if (!q) return '—';
    const fee = formatFixed(q.nativeFee, this.wallet.currency.decimals);
    const f = settings.value.fiatApiMode === 'disabled' ? null : fiatValue(Number(fee), apiString(this.wallet.currency));
    return [`${max8(fee)} ${this.wallet.currency.title}`, f !== null ? `(${settings.value.fiatCurrency} ${formatFiatAmount(f)})` : ''].filter(Boolean).join(' ');
  }

  setMaxAmount(): void {
    this.amount.value = this.balance === 0n ? '' : formatFixed(this.balance, this.token.decimals);
  }

  setRecipientAddress(address: string, name: string | null = null): void {
    this.recipientAddress.value = address;
    this.destinationWalletName.value = name;
  }

  #check(): { error: string } | { amount: bigint; dst: number } {
    const dst = this.destinationChainId.value;
    if (dst === null || !this.amount.value || !this.recipientAddress.value.trim()) return { error: 'Fill all fields' };
    const a = this.parsedAmount;
    if (a === null || a === 0n) return { error: 'Invalid amount' };
    if (a > this.balance) return { error: `Insufficient balance for ${this.token.symbol} token.` };
    return { amount: a, dst };
  }

  async loadQuote(): Promise<void> {
    const c = this.#check();
    if ('error' in c) {
      this.quoteError.value = c.error;
      return;
    }
    this.isQuoteLoading.value = true;
    this.quote.value = null;
    this.quoteError.value = null;
    this.executeError.value = null;
    try {
      this.quote.value = await quoteUsdt0(this.wallet, this.sourceChainId, c.dst, c.amount, this.recipientAddress.value.trim());
    } catch (e) {
      this.quoteError.value = (e as Error).message;
    } finally {
      this.isQuoteLoading.value = false;
    }
  }

  /** executeBridge: the transaction, its record, then the polling */
  async executeBridge(): Promise<void> {
    const q = this.quote.value;
    if (!q) {
      this.executeError.value = 'Get a quote first';
      return;
    }
    const c = this.#check();
    if ('error' in c) {
      this.executeError.value = c.error;
      return;
    }
    this.isExecuting.value = true;
    this.executeError.value = null;
    try {
      const w = this.wallet;
      const pending = await executeUsdt0(w, { src: this.sourceChainId, dst: c.dst, amount: c.amount, recipient: this.recipientAddress.value.trim(), fee: q, token: this.token.address!, tokenKey: this.token.key, priority: w.defaultPriority() });
      await pending.commit();
      const record: BridgeTransfer = {
        id: `${pending.id}_${Date.now()}`,
        walletId: w.id,
        sourceChainId: this.sourceChainId,
        destinationChainId: c.dst,
        tokenSymbol: this.token.symbol,
        tokenContract: this.token.address!,
        amount: this.amount.value,
        recipientAddress: this.recipientAddress.value.trim(),
        sourceTxHash: pending.id,
        status: 'submitted',
        createdAt: Date.now(),
      };
      await addBridgeTransfer(record);
      this.quote.value = null;
      this.bridgeSuccess.value = true;
      void pollBridgeTransfer(record, w, true);
    } catch (e) {
      this.executeError.value = (e as Error).message;
    } finally {
      this.isExecuting.value = false;
    }
  }
}

// ------------------------------------------------------------- amount --

function AmountPage({ args }: { args: { asset: TokenAsset } }) {
  const w = currentWallet.value as BridgeWallet | null;
  const vmRef = useRef<BridgeVM | null>(null);
  if (w && !vmRef.current) vmRef.current = new BridgeVM(w, args.asset);
  const vm = vmRef.current;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    watchPrice(args.asset.api);
    input.current?.focus();
    if (w) resumeBridgePolling(w);
  }, []);
  if (!w || !vm) return null;
  void prices.value;
  const canNext = vm.canProceedToDestinationNetwork;
  const fiat = vm.amount.value ? vm.fiatOf(vm.amount.value) : '';
  return (
    <Page
      title={t('enter_amount')}
      id="bridge_amount_page"
      bodyClass=""
      trailing={<ModernButton icon="history" size={36} color="var(--on-surface-variant)" label={t('history')} id="bridge_history_button" onClick={() => nav.push(Routes.bridgeHistoryPage)} />}
    >
      <div class="col" style={{ height: '100%', padding: '0 18px' }}>
        <div style={{ flex: 2 }} />
        <div class="rowx" style={{ justifyContent: 'center', alignItems: 'baseline', gap: '8px', maxWidth: '100%' }}>
          <input
            ref={input}
            id="bridge_amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={vm.amount.value}
            size={Math.max(4, vm.amount.value.length + 1)}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              if (/^\d*[.,]?\d*$/.test(v)) vm.amount.value = v;
              else (e.target as HTMLInputElement).value = vm.amount.value;
            }}
            style={{ border: 0, outline: 'none', background: 'none', color: 'var(--on-surface)', fontSize: '45px', fontWeight: 400, textAlign: 'end', padding: 0, minWidth: 0, maxWidth: '65vw' }}
          />
          <span style={{ fontSize: '45px', color: 'var(--on-surface-variant)', whiteSpace: 'nowrap' }}>{vm.token.symbol}</span>
        </div>
        <div class="center" style={{ fontSize: '22px', color: 'var(--on-surface-variant)', minHeight: '30px' }} id="bridge_amount_fiat">{fiat ? `~${fiat} ${settings.value.fiatCurrency}` : ''}</div>
        {vm.amountError && <div class="center" style={{ color: 'var(--error)', fontSize: '14px' }} id="bridge_amount_error">{vm.amountError}</div>}
        <div style={{ flex: 3 }} />
        <div class="rowx" style={{ gap: '8px', paddingBottom: '24px' }}>
          <span class="rowx grow" style={{ gap: '8px', fontSize: '16px', minWidth: 0 }}>
            <span class="muted">{t('available')}</span>
            <span id="bridge_available" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{`${formatFixed(vm.balance, vm.token.decimals)} ${vm.token.symbol}`}</span>
          </span>
          <button type="button" id="bridge_max" onClick={() => { vm.setMaxAmount(); input.current?.focus(); }} style={{ height: '34px', padding: '0 16px', borderRadius: '999px', border: 0, background: 'var(--surface-container)', color: 'var(--primary)', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>{t('max')}</button>
          <button type="button" id="bridge_amount_next" aria-label={t('continue_text')} disabled={!canNext} onClick={() => nav.push(Routes.bridgeDestinationNetworkPage, { vm })} style={{ width: '34px', height: '34px', borderRadius: '50%', border: 0, background: 'var(--primary)', color: 'var(--on-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: canNext ? 'pointer' : 'default', opacity: canNext ? 1 : 0.5 }}>
            <MIcon name="arrow_forward" size={20} color="var(--on-primary)" />
          </button>
        </div>
      </div>
    </Page>
  );
}

// ------------------------------------------------------------ network --

function NetworkPage({ args }: { args: { vm: BridgeVM } }) {
  const vm = args.vm;
  const type = vm.wallet.type;
  return (
    <Page title="Destination Network" id="bridge_network_page" bodyClass="">
      <div class="col" style={{ padding: '48px 18px 24px', gap: '24px' }}>
        <div class="center muted" style={{ padding: '8px 0 16px' }}>Select what Network to transfer your assets to</div>
        <div class="list">
          {vm.availableDestinationChains.map((id) => (
            <button type="button" class="row tap has-icon" id={`bridge_network_${id}`} onClick={() => { vm.destinationChainId.value = id; nav.push(Routes.bridgeReceivingWalletPage, { vm }); }}>
              <Img src={fullIcon(id)} size={24} />
              <span class="lbl"><span>{chainName(id)}</span></span>
              <Icon src="arrow_forward.svg" w={8} h={14} color="var(--on-surface-variant)" class="chev" />
            </button>
          ))}
        </div>
        <div class="list">
          <div class="row" id="bridge_sending_from">
            <span class="lbl"><span>Sending from</span></span>
            <span class="rowx" style={{ gap: '6px', color: 'var(--on-surface-variant)' }}><Icon src={badge(type)} size={18} color="var(--on-surface-variant)" />{capitalized(type)}</span>
          </div>
        </div>
      </div>
    </Page>
  );
}

// ---------------------------------------------------- receiving wallet --

function ReceivingWalletPage({ args }: { args: { vm: BridgeVM } }) {
  const vm = args.vm;
  const dst = vm.destinationChainId.value!;
  const type = chainById(dst)?.type;
  const name = chainName(dst);
  // loadReceivingWalletOptions: this chain's wallets (not hardware ones)
  const options = walletInfos.value.filter((w) => w.type === type && !w.hardwareWalletType);
  const pick = (address: string, walletName: string | null) => {
    vm.setRecipientAddress(address, walletName);
    void openConfirm(vm);
  };
  return (
    <Page title="Receiving Wallet" id="bridge_receiving_wallet_page" bodyClass="">
      <div class="col" style={{ padding: '56px 18px 24px', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}><Img src={fullIcon(dst)} size={72} style={{ borderRadius: '8px' }} /></div>
        <div class="center muted" style={{ fontSize: '14px', padding: '8px 0 12px' }}>{`Select a ${name} wallet or address to send the bridged USDT0 to.`}</div>
        {options.map((o) => {
          const group = settings.value.walletGroupNames[walletGroupKey(o)];
          const current = o.name === vm.wallet.name;
          return (
            <div class="list">
              <button type="button" class="row tap" id={`bridge_receiving_${o.id}`} onClick={() => pick(o.address, o.name)} style={{ minHeight: group ? '62px' : '48px' }}>
                <span class="lbl">
                  <span>{o.name}</span>
                  {group && (
                    <span class="rowx" style={{ gap: '6px', fontSize: '12px', color: 'var(--on-surface-variant)' }}>
                      <MIcon name="account_balance_wallet_outlined" size={16} color="var(--on-surface-variant)" />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{group}</span>
                      {current && <span style={{ color: 'var(--primary)' }}>Current</span>}
                    </span>
                  )}
                </span>
                <Icon src="arrow_forward.svg" w={8} h={14} color="var(--on-surface-variant)" class="chev" />
              </button>
            </div>
          );
        })}
        <div class="list">
          <button type="button" class="row tap has-icon" id="bridge_input_address" onClick={() => nav.push(Routes.bridgeReceiveAddressInputPage, { vm })} style={{ minHeight: '48px' }}>
            <MIcon name="edit" size={24} color="var(--on-surface)" />
            <span class="lbl"><span>Input an Address</span></span>
          </button>
        </div>
      </div>
    </Page>
  );
}

function AddressInputPage({ args }: { args: { vm: BridgeVM } }) {
  const vm = args.vm;
  const dst = vm.destinationChainId.value!;
  const type = chainById(dst)?.type ?? 'ethereum';
  const [address, setAddress] = useState('');
  const [touched, setTouched] = useState(false);
  const valid = isValidEvmAddress(address.trim());
  return (
    <Page
      title="Input Receive Address"
      id="bridge_address_input_page"
      footer={<Button id="bridge_address_continue" onClick={() => {
        setTouched(true);
        if (!valid) return;
        vm.setRecipientAddress(address.trim());
        void openConfirm(vm);
      }}>{t('continue_text')}</Button>}
    >
      <div class="col" style={{ paddingTop: '48px', gap: '24px' }}>
        <div class="col" style={{ alignItems: 'center', gap: '8px' }}>
          <span class="muted" style={{ fontSize: '14px' }}>Make sure it is compatible with:</span>
          <span class="rowx" style={{ gap: '4px', fontSize: '14px' }}><Icon src={badge(type)} size={24} color="var(--on-surface-variant)" />{chainName(dst)}</span>
        </div>
        <div class="col" style={{ gap: '6px' }}>
          <div class="rowx" style={{ background: 'var(--surface-container)', borderRadius: '18px', minHeight: '56px', padding: '0 12px', gap: '12px', border: touched && !valid ? '1px solid var(--error)' : '1px solid transparent' }}>
            <input id="bridge_address" value={address} placeholder="Enter Address" spellcheck={false} autoComplete="off" onInput={(e) => setAddress((e.target as HTMLInputElement).value)} onBlur={() => setTouched(true)} style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 0, color: 'var(--on-surface)', fontSize: '16px', fontFamily: 'inherit' }} />
            <button type="button" class="ficon" aria-label={t('paste')} onClick={async () => { try { setAddress((await navigator.clipboard.readText()).trim()); } catch { /* clipboard blocked */ } }}><Icon src="paste.svg" size={22} /></button>
            <button type="button" class="ficon" aria-label={t('scan')} onClick={async () => { const v = await nav.pushForResult<string>('/scan', { mode: 'address' }); if (v) setAddress(v.replace(/^ethereum:/i, '').split(/[@?]/)[0]); }}><Icon src="scan.svg" size={22} /></button>
            <button type="button" class="ficon" aria-label={t('address_book')} onClick={async () => { const c = await nav.pushForResult<{ address: string }>(Routes.pickerAddressBook, { currency: vm.wallet.currency.key }); if (c) setAddress(c.address); }}><Icon src="contacts_outlined.svg" size={22} /></button>
          </div>
          {touched && address && !valid && <div class="field-error" id="bridge_address_error">{t('error_text_address')}</div>}
        </div>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------- confirmation --

/** ExpandableBridgeDetailRow */
function DetailRow({ label, title, address, chevron, id }: { label: string; title: string; address?: string; chevron: boolean; id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="col" id={id}>
      <div class="rowx" onClick={chevron ? () => setOpen(!open) : undefined} style={{ padding: '14px 16px', gap: '12px', cursor: chevron ? 'pointer' : 'default', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '14px' }}>{label}</span>
        <span class="rowx grow" style={{ justifyContent: 'flex-end', gap: '2px', minWidth: 0 }}>
          <span style={{ fontSize: '14px', color: 'var(--on-surface-variant)', textAlign: 'end', overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{title}</span>
          {chevron && <MIcon name="chevronDown" size={22} color="var(--on-surface-variant)" style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s', flex: 'none' }} />}
        </span>
      </div>
      {chevron && open && address && <div style={{ padding: '0 16px 14px', textAlign: 'end', fontSize: '12px', color: 'var(--on-surface-variant)', overflowWrap: 'anywhere' }}>{address}</div>}
    </div>
  );
}

function openConfirm(vm: BridgeVM): Promise<void> {
  return showSheet<void>((close) => <ConfirmSheet vm={vm} close={close} />, { dismissible: false }).then(() => {
    if (vm.bridgeSuccess.value) void successSheet(vm);
  });
}

function ConfirmSheet({ vm, close }: { vm: BridgeVM; close: () => void }) {
  useEffect(() => {
    void vm.loadQuote();
    watchPrice(apiString(vm.wallet.currency));
  }, []);
  useEffect(() => {
    if (vm.bridgeSuccess.value) close();
  }, [vm.bridgeSuccess.value]);
  void prices.value;
  const amount = vm.amount.value.replace(',', '.');
  const dst = vm.destinationChainId.value!;
  let body: ComponentChildren;
  if (vm.isQuoteLoading.value && !vm.quote.value) body = <div class="center" style={{ padding: '48px 0' }} id="bridge_quote_loading"><Spinner /></div>;
  else if (vm.quoteError.value) {
    body = (
      <div class="col" style={{ gap: '16px', paddingBottom: '24px', alignItems: 'center' }}>
        <div class="center" style={{ fontSize: '14px', color: 'var(--error)', overflowWrap: 'anywhere' }} id="bridge_quote_error">{vm.quoteError.value}</div>
        <Button onClick={() => void vm.loadQuote()}>{t('try_again')}</Button>
      </div>
    );
  } else {
    const fiat = vm.fiatOf(amount);
    body = (
      <div class="col" style={{ gap: '24px' }}>
        <div class="col" style={{ alignItems: 'center', gap: '4px' }}>
          <span style={{ fontSize: '36px' }} id="bridge_confirm_amount">{`${amount} `}<span class="muted">{vm.token.symbol}</span></span>
          {settings.value.fiatApiMode !== 'disabled' && <span class="muted" style={{ fontSize: '20px' }}>{`${settings.value.fiatCurrency} ${fiat}`}</span>}
        </div>
        <div class="rowx" style={{ justifyContent: 'center' }}>
          <span class="rowx" style={{ gap: '8px', padding: '8px 12px', borderRadius: '999px', background: 'var(--surface-container)', fontSize: '16px' }} id="bridge_network_path">
            <Icon src={badge(vm.wallet.type)} size={24} color="var(--on-surface-variant)" />{capitalized(vm.wallet.type)}
            <MIcon name="arrow_forward" size={16} color="var(--primary)" />
            <Icon src={badge(chainById(dst)?.type ?? '')} size={24} color="var(--on-surface-variant)" />{chainName(dst)}
          </span>
        </div>
        <div style={{ background: 'var(--surface-container)', borderRadius: '16px' }} id="bridge_confirm_details">
          <DetailRow label={t('from')} title={vm.wallet.name} address={vm.wallet.address} chevron id="bridge_confirm_from" />
          <div style={{ height: '1px', background: 'var(--surface-container-high)' }} />
          <DetailRow label={t('to')} title={vm.destinationWalletName.value ?? vm.recipientAddress.value.trim()} address={vm.recipientAddress.value.trim()} chevron={vm.destinationWalletName.value !== null} id="bridge_confirm_to" />
          <div style={{ height: '1px', background: 'var(--surface-container-high)' }} />
          <DetailRow label={t('fee')} title={vm.feeLine} chevron={false} id="bridge_confirm_fee" />
        </div>
        {vm.executeError.value && <div class="center" style={{ color: 'var(--error)', fontSize: '14px', overflowWrap: 'anywhere' }} id="bridge_execute_error">{vm.executeError.value}</div>}
        <div style={{ height: '8px' }} />
      </div>
    );
  }
  const loadingRow = (label: string) => <div class="rowx" style={{ justifyContent: 'center', gap: '12px', height: '60px', color: 'var(--on-surface-variant)' }}><Spinner /> {label}</div>;
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '30px 30px 0 0' }} id="bridge_confirm_sheet">
      <TopBar
        leading={<span class="rowx" style={{ gap: '8px', paddingLeft: '8px' }}><Img src={vm.token.icon} size={36} round /><span style={{ fontSize: '20px', fontWeight: 500 }}>Bridge</span></span>}
        trailing={!vm.isExecuting.value ? <ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} onClick={close} /> : undefined}
      />
      <div style={{ padding: '0 24px' }}>{body}</div>
      <div style={{ padding: '0 24px 16px' }}>
        {vm.isExecuting.value ? loadingRow(`${t('bridging')}...`) : vm.isQuoteLoading.value || !vm.quote.value ? (vm.quoteError.value ? null : loadingRow(`${t('loading')}...`)) : <ConfirmSwiper label={t('swipe_to_bridge')} onConfirm={() => void vm.executeBridge()} />}
      </div>
    </div>
  );
}

/** "Bridge initiated!" */
function successSheet(vm: BridgeVM): Promise<void> {
  return showSheet<void>((close) => (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', padding: '0 24px 24px', gap: '16px', alignItems: 'center' }} id="bridge_success_sheet">
      <TopBar title="Bridge initiated!" />
      <Img src="assets/images/birthday_cake.png" size={180} />
      <div class="center" style={{ fontSize: '14px' }}>The bridging will take between 30 seconds and 3 minutes to complete.</div>
      <div class="rowx" style={{ gap: '12px', width: '100%' }}>
        <div class="grow"><Button secondary id="bridge_success_close" onClick={() => { close(); nav.popUntil(Routes.dashboard); }}>{t('close')}</Button></div>
        <div class="grow"><Button id="bridge_success_history" onClick={() => { close(); nav.popUntil(Routes.dashboard); nav.push(Routes.bridgeHistoryPage); }}>View history</Button></div>
      </div>
    </div>
  )).then(() => void vm);
}

// ------------------------------------------------------------- history --

const statusColor = (s: string) => (s === 'completed' ? '#2CCF6F' : s === 'failed' ? 'var(--error)' : 'var(--warning-outline)');
const pad = (n: number) => String(n).padStart(2, '0');

/** TransferHistoryRow */
function TransferRow({ tr }: { tr: BridgeTransfer }) {
  const d = new Date(tr.createdAt);
  return (
    <button type="button" class="rowx" id={`bridge_transfer_${tr.sourceTxHash.slice(2, 12)}`} onClick={() => nav.push(Routes.bridgeDetailPage, { id: tr.id })} style={{ width: '100%', gap: '12px', padding: '12px', border: 0, borderRadius: '16px', background: 'var(--surface-container)', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start', marginBottom: '8px' }}>
      <span style={{ position: 'relative', width: '48px', height: '36px', flex: 'none' }}>
        <span style={{ position: 'absolute', left: 0, top: 0 }}><Img src={fullIcon(tr.sourceChainId)} size={32} /></span>
        <span style={{ position: 'absolute', left: '16px', top: '4px' }}><Img src={fullIcon(tr.destinationChainId)} size={32} /></span>
      </span>
      <span class="col grow" style={{ gap: '4px', minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{`${chainName(tr.sourceChainId)} → ${chainName(tr.destinationChainId)}`}</span>
        <span class="muted" style={{ fontSize: '14px' }}>{`${tr.amount} ${tr.tokenSymbol}`}</span>
      </span>
      <span class="col" style={{ alignItems: 'flex-end', gap: '4px', flex: 'none' }}>
        <span class="rowx" style={{ gap: '6px', fontSize: '12px' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: statusColor(tr.status) }} />{bridgeStatusLabel(tr.status)}</span>
        <span class="muted" style={{ fontSize: '12px' }}>{`${pad(d.getHours())}:${pad(d.getMinutes())}`}</span>
      </span>
    </button>
  );
}

function HistoryPage() {
  const w = currentWallet.value;
  useEffect(() => {
    if (w && 'transactionReceipt' in w) resumeBridgePolling(w as unknown as ReceiptWallet);
  }, [w?.id]);
  if (!w) return null;
  const mine = bridgeTransfers.value.filter((x) => x.walletId === w.id);
  const active = mine.filter(isActive);
  const past = mine.filter((x) => !isActive(x));
  const section = (title: string, list: BridgeTransfer[], top: number) => (
    <>
      <div style={{ fontSize: '14px', fontWeight: 600, padding: `${top}px 0 8px` }}>{title}</div>
      {list.map((tr) => <TransferRow tr={tr} />)}
    </>
  );
  return (
    <Page title="Bridge history" solid id="bridge_history_page">
      {!mine.length ? (
        <div class="center" style={{ padding: '40% 24px 0', fontSize: '16px' }} id="bridge_history_empty">No bridge transfers yet.</div>
      ) : (
        <div class="col" id="bridge_history_list">
          {active.length > 0 && section('In progress', active, 0)}
          {past.length > 0 && section('Past', past, active.length ? 16 : 0)}
        </div>
      )}
    </Page>
  );
}

/** BridgeDetailPage: status, chains, amount, recipient (copied on a tap), the explorer, the error */
function DetailPage({ args }: { args: { id: string } }) {
  const tr = bridgeTransfers.value.find((x) => x.id === args.id);
  if (!tr) return null;
  const status = tr.statusMessage ? `${bridgeStatusLabel(tr.status)} · ${tr.statusMessage}` : bridgeStatusLabel(tr.status);
  const explorer = chainById(tr.sourceChainId)?.explorer;
  const url = explorer ? `${explorer}/tx/${tr.sourceTxHash}` : null;
  const row = (label: string, value: ComponentChildren, id: string, onClick?: () => void) => (
    <div class={`row${onClick ? ' tap' : ''}`} id={id} onClick={onClick}>
      <span class="lbl"><span class="muted" style={{ fontSize: '12px' }}>{label}</span><span style={{ overflowWrap: 'anywhere' }}>{value}</span></span>
    </div>
  );
  return (
    <Page title="Bridge Transfer Details" solid id="bridge_detail_page">
      <div class="list">
        {row('Status', <span class="rowx" style={{ gap: '6px' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: statusColor(tr.status), flex: 'none' }} />{status}</span>, 'bridge_detail_status')}
        {row('Source chain', chainName(tr.sourceChainId), 'bridge_detail_source')}
        {row('Destination chain', chainName(tr.destinationChainId), 'bridge_detail_destination')}
        {row('Amount', `${tr.amount} ${tr.tokenSymbol}`, 'bridge_detail_amount')}
        {row('Recipient', tr.recipientAddress, 'bridge_detail_recipient', () => void copyText(tr.recipientAddress))}
        {url && (
          <div class="row tap" id="bridge_detail_explorer" onClick={() => void openExternal(url)}>
            <span class="lbl"><span style={{ color: 'var(--primary)' }}>{`${t('view_transaction_on')}${new URL(url).host}`}</span></span>
            <Icon src="link_arrow.svg" size={8} color="var(--primary)" />
          </div>
        )}
        {tr.errorMessage && row('Error', tr.errorMessage, 'bridge_detail_error')}
      </div>
    </Page>
  );
}

registerRoute(Routes.bridgeAmountPage, AmountPage);
registerRoute(Routes.bridgeDestinationNetworkPage, NetworkPage);
registerRoute(Routes.bridgeReceivingWalletPage, ReceivingWalletPage);
registerRoute(Routes.bridgeReceiveAddressInputPage, AddressInputPage);
registerRoute(Routes.bridgeHistoryPage, HistoryPage);
registerRoute(Routes.bridgeDetailPage, DetailPage);
