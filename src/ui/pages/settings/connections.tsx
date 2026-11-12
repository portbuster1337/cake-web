// Connections (connection_sync_page.dart), Domain lookups, Manage nodes,
// node create/edit (node_create_or_edit_page.dart), and the Tor settings
// (the web client's equivalent of "Enable built-in Tor": it is always on).

import { useEffect, useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Button, Field, Icon, Img, MIcon, ModernButton, Page, Row, Section, Sections, Spinner, ToggleRow } from '../../components/core.tsx';
import { confirmAlert, showAlert, toast } from '../../components/overlays.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { ModalHeader } from './main.tsx';
import { pickOption } from '../newWallet.tsx';
import { settings, updateSettings, type FiatApiMode, type Settings } from '../../../app/settings.ts';
import { currentWallet, net, saveNodes, setUserRelays, effectiveRelays, BUILTIN_RELAYS, torStatus } from '../../../app/app.ts';
import { currentNode, customNodes, nodesFor, setCurrentNode, nodeHost, type Node, type NodeKind } from '../../../core/nodes.ts';
import { getJson, jsonRpc, postJson, request } from '../../../net/http.ts';
import type { WalletType } from '../../../coins/types.ts';
import { isEvm } from '../../../coins/types.ts';
import { db } from '../../../core/db.ts';

const MODES: { id: FiatApiMode; label: string }[] = [
  { id: 'enabled', label: 'Enabled' },
  { id: 'torOnly', label: 'Tor only' },
  { id: 'disabled', label: 'Disabled' },
];

function ConnectionsPage() {
  const s = settings.value;
  const w = currentWallet.value;
  const chainId = (w as any)?.chainId as number | undefined;
  const set = (p: Partial<Settings>) => updateSettings(p);
  return (
    <Page title={t('connections')} solid id="connections_page">
      <ModalHeader icon="assets/new-ui/settings_row_icons/connections.svg" title={t('connections')} message={t('connections_desc')} />
      <Section>
        <Row label={<span class="rowx gap8"><img src="./cake/new-ui/tor.svg" alt="" style={{ width: '18px' }} />Tor</span>} trailingText={torStatus.value.state === 'ready' ? t('connected') : torStatus.value.message} id="connections_tor" onClick={() => nav.push(Routes.torSettings)} />
        <ToggleRow label={t('disable_automatic_exchange_status_updates')} value={s.disableAutomaticExchangeStatusUpdates} onChange={(v) => set({ disableAutomaticExchangeStatusUpdates: v })} />
        {(chainId === 1 || chainId === 8453) && <ToggleRow label={t('use_blink_protection')} value={s.useBlinkProtection} onChange={(v) => set({ useBlinkProtection: v })} />}
        {chainId === 1 && <ToggleRow label={t('etherscan_history')} value={s.useEtherscan} onChange={(v) => set({ useEtherscan: v })} />}
        {chainId === 137 && <ToggleRow label={t('polygonscan_history')} value={s.usePolygonScan} onChange={(v) => set({ usePolygonScan: v })} />}
        {chainId === 8453 && <ToggleRow label={t('basescan_history')} value={s.useBaseScan} onChange={(v) => set({ useBaseScan: v })} />}
        {chainId === 42161 && <ToggleRow label={t('arbiscan_history')} value={s.useArbiScan} onChange={(v) => set({ useArbiScan: v })} />}
        {chainId === 56 && <ToggleRow label={t('bscscan_history')} value={s.useBscScan} onChange={(v) => set({ useBscScan: v })} />}
        {w?.type === 'tron' && <ToggleRow label={t('trongrid_history')} value={s.useTronGrid} onChange={(v) => set({ useTronGrid: v })} />}
        {w?.type === 'bitcoin' && (
          <ToggleRow
            label={t('enable_mempool_api')}
            value={s.useMempoolFeeAPI}
            onChange={async (v) => {
              if (!v && !(await confirmAlert(t('warning'), t('disable_fee_api_warning')))) return;
              set({ useMempoolFeeAPI: v });
            }}
          />
        )}
        {w?.type === 'nano' && <Row label={t('manage_pow_nodes')} onClick={() => nav.push(Routes.managePowNodes)} />}
        <Row label={t('fiat_api')} trailingText={MODES.find((m) => m.id === s.fiatApiMode)?.label} id="connections_fiat_api" onClick={async () => {
          const v = await pickOption(t('fiat_api'), MODES.map((m) => ({ id: m.id, label: t(m.id === 'torOnly' ? 'tor_only' : m.id) })), s.fiatApiMode);
          if (v) set({ fiatApiMode: v as FiatApiMode });
        }} />
        <Row label={t('swap')} trailingText={MODES.find((m) => m.id === s.exchangeStatus)?.label} id="connections_swap" onClick={async () => {
          const v = await pickOption(t('swap'), MODES.map((m) => ({ id: m.id, label: t(m.id === 'torOnly' ? 'tor_only' : m.id) })), s.exchangeStatus);
          if (v) set({ exchangeStatus: v as FiatApiMode });
        }} />
        <Row label={t('domain_looks_up')} id="connections_lookups" onClick={() => nav.push(Routes.domainLookupsPage)} />
        {w?.hasRescan && w.type !== 'bitcoin' && w.type !== 'litecoin' && <Row label={t('rescan')} onClick={() => nav.push(Routes.rescan)} />}
        <Row label="API keys" id="connections_api_keys" onClick={() => nav.push(Routes.apiKeysPage)} />
        <Row label={t('network_requests') === 'network_requests' ? 'Network activity' : t('network_requests')} id="connections_activity" onClick={() => nav.push(Routes.devNetworkRequests)} />
      </Section>
    </Page>
  );
}

const LOOKUPS: { label: string; key: keyof Settings; icon: string }[] = [
  { label: 'LNURL Pay', key: 'lookupsLnurl', icon: 'icon-lnurl-pay.svg' },
  { label: 'X', key: 'lookupsTwitter', icon: 'x.svg' },
  { label: 'Mastodon', key: 'lookupsMastodon', icon: 'mastodon.svg' },
  { label: 'Yat', key: 'lookupsYatService', icon: 'yat.svg' },
  { label: 'Unstoppable Domains', key: 'lookupsUnstoppableDomains', icon: 'unstoppable.svg' },
  { label: 'OpenAlias', key: 'lookupsOpenAlias', icon: 'openalias.svg' },
  { label: 'Ethereum Name Service', key: 'lookupsENS', icon: 'ens.svg' },
  { label: 'Zcash Names', key: 'lookupsZcashNames', icon: 'icon-zcashnames.svg' },
  { label: 'Zcash.me', key: 'lookupsZcashMe', icon: 'icon-zcash-me.svg' },
  { label: '.wellknown', key: 'lookupsWellKnown', icon: 'wellknown.svg' },
  { label: 'Zano Alias', key: 'lookupsZanoAlias', icon: 'zano.svg' },
  { label: 'BIP353', key: 'lookupsBip353', icon: 'bip353.svg' },
  { label: 'FIO', key: 'lookupsFio', icon: 'fio.svg' },
  { label: 'ThorChain', key: 'lookupsThorChain', icon: 'icon-thorchain.svg' },
  { label: 'Nostr', key: 'lookupsNostr', icon: 'nostr.svg' },
];

function DomainLookupsPage() {
  const s = settings.value as any;
  return (
    <Page title={t('domain_looks_up')} solid id="domain_lookups_page">
      <Section>
        {LOOKUPS.map((l) => (
          <div class="row tap has-icon" onClick={() => updateSettings({ [l.key]: !s[l.key] } as any)}>
            <Img src={`assets/new-ui/address_sources/${l.icon}`} size={24} />
            <span class="lbl">{l.label}</span>
            <button type="button" role="switch" aria-checked={!!s[l.key]} class={`switch${s[l.key] ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); updateSettings({ [l.key]: !s[l.key] } as any); }} />
          </div>
        ))}
      </Section>
    </Page>
  );
}

/** Node.requestNode(): one cheap call per node kind */
export async function testNode(n: Node): Promise<number> {
  const t0 = performance.now();
  const opts = { scope: 'node-test', retries: 0, timeoutMs: 30_000, purpose: 'node test' };
  const base = n.url.replace(/\/+$/, '');
  switch (n.kind) {
    case 'monerod':
      await postJson(`${base}/json_rpc`, { jsonrpc: '2.0', id: '0', method: 'get_info' }, { ...opts, username: n.login, password: n.password });
      break;
    case 'esplora':
      await request(`${base}/blocks/tip/height`, undefined, opts);
      break;
    case 'blockbook':
      await getJson(`${base}/api/v2`, opts);
      break;
    case 'blockchair':
      await getJson(`${base}/${n.chain}/stats`, opts);
      break;
    case 'evm':
      await jsonRpc(base, 'eth_blockNumber', [], opts);
      break;
    case 'solana':
      await jsonRpc(base, 'getSlot', [], opts);
      break;
    case 'tron':
      await postJson(`${base}/wallet/getnowblock`, {}, opts);
      break;
    case 'nano':
    case 'nanoPow':
      await postJson(base, { action: 'block_count' }, opts);
      break;
    default:
      await request(base, undefined, opts);
  }
  return performance.now() - t0;
}

function ManageNodesPage({ args }: { args?: { pow?: boolean } }) {
  const w = currentWallet.value;
  const pow = !!args?.pow;
  const [speeds, setSpeeds] = useState<Record<string, number | null>>({});
  const [testing, setTesting] = useState(false);
  if (!w) return null;
  const type = w.type;
  void customNodes.value;
  const list = nodesFor(type, pow);
  const cur = currentNode(type, pow);
  const run = async () => {
    setTesting(true);
    const res: Record<string, number | null> = {};
    await Promise.all(list.map(async (n) => {
      try {
        res[n.id] = await testNode(n);
      } catch {
        res[n.id] = null;
      }
      setSpeeds({ ...res });
    }));
    setTesting(false);
  };
  useEffect(() => {
    const id = setTimeout(() => void run(), 300);
    return () => clearTimeout(id);
  }, [type, pow]);
  const ok = Object.values(speeds).filter((x): x is number => typeof x === 'number');
  const best = ok.length ? Math.min(...ok) : 0;
  const badge = (n: Node) => {
    if (!(n.id in speeds) || !ok.length) return null;
    const s = speeds[n.id];
    const kind = s === null ? 'disconnected' : s < best / 0.8 ? 'fast' : s < best / 0.5 ? 'medium' : 'slow';
    return <img src={`./cake/new-ui/node_speed_badges/${kind}${document.documentElement.dataset.theme === 'light' ? '' : '-dark'}.svg`} alt={kind} style={{ height: '18px' }} onError={(e) => ((e.target as HTMLImageElement).src = `./cake/new-ui/node_speed_badges/${kind}.svg`)} />;
  };
  const select = async (n: Node) => {
    if (n.id === cur.id) return;
    if (!(await confirmAlert(t('change_current_node_title'), t('change_current_node', { node: n.url }), t('change')))) return;
    setCurrentNode(type, n.id, pow);
    await saveNodes();
    if (!pow) {
      try {
        await w.close();
        const { openWallet } = await import('../../../app/app.ts');
        await openWallet(w.id);
      } catch (e) {
        toast((e as Error).message);
      }
    }
  };
  return (
    <Page
      title={t('manage_nodes')}
      solid
      id="manage_nodes_page"
      trailing={
        <div class="rowx gap8">
          <ModernButton icon="refresh" size={36} label={t('test_node_speeds')} disabled={testing} onClick={() => void run()} />
          <ModernButton icon="add" size={36} label={t('add_new_node')} id="add_node" onClick={() => nav.push(pow ? Routes.newPowNode : Routes.newNode, { type, pow })} />
        </div>
      }
    >
      <ModalHeader icon="assets/new-ui/settings_row_icons/nodes.svg" title={t('nodes')} message={t('nodes_desc')} />
      <Sections>
        <Section>
          <div class="row">
            <MIcon name="check" color="var(--primary)" />
            <span class="lbl"><span>{cur.label ?? nodeHost(cur)}</span>{cur.label && <span class="sub">{nodeHost(cur)}</span>}</span>
            {badge(cur)}
          </div>
        </Section>
        <Section>
          {list.filter((n) => n.id !== cur.id).map((n) => (
            <div class="row tap" onClick={() => void select(n)} id={`node_${nodeHost(n).replace(/[^a-z0-9]/gi, '_')}`}>
              <span class="lbl"><span class="rowx gap8">{n.label ?? nodeHost(n)}{n.builtin && <img src="./cake/new-ui/default_node.svg" alt="" style={{ height: '14px' }} />}</span>{n.label && <span class="sub">{nodeHost(n)}</span>}</span>
              {testing && !(n.id in speeds) ? <Spinner /> : badge(n)}
              <button type="button" class="ficon" aria-label={t('edit')} onClick={(e) => { e.stopPropagation(); nav.push(pow ? Routes.newPowNode : Routes.newNode, { type, pow, node: n }); }}>
                <Icon src="3dots.svg" size={16} color="var(--on-surface-variant)" />
              </button>
            </div>
          ))}
        </Section>
      </Sections>
    </Page>
  );
}

function defaultKind(type: WalletType, pow: boolean): NodeKind {
  if (pow) return 'nanoPow';
  if (type === 'monero' || type === 'wownero') return 'monerod';
  if (type === 'bitcoin' || type === 'litecoin') return 'esplora';
  if (type === 'bitcoinCash' || type === 'dogecoin') return 'blockbook';
  if (isEvm(type)) return 'evm';
  if (type === 'solana') return 'solana';
  if (type === 'tron') return 'tron';
  if (type === 'nano') return 'nano';
  if (type === 'decred') return 'decred';
  if (type === 'zcash') return 'zcash';
  return 'evm';
}

function NodeFormPage({ args }: { args: { type: WalletType; pow?: boolean; node?: Node } }) {
  const ex = args.node;
  const editable = !ex?.builtin;
  const initial = ex ? new URL(ex.url) : null;
  const [label, setLabel] = useState(ex?.label ?? '');
  const [address, setAddress] = useState(initial?.hostname ?? '');
  const [port, setPort] = useState(initial?.port ?? '');
  const [path, setPath] = useState(initial && initial.pathname !== '/' ? initial.pathname : '');
  const [ssl, setSsl] = useState(initial ? initial.protocol === 'https:' : !address.endsWith('.onion'));
  const [login, setLogin] = useState(ex?.login ?? '');
  const [password, setPassword] = useState(ex?.password ?? '');
  const [trusted, setTrusted] = useState(!!ex?.trusted);
  const [kind, setKind] = useState<NodeKind>(ex?.kind ?? defaultKind(args.type, !!args.pow));
  const [testResult, setTestResult] = useState<string | null>(null);
  const addrOk = /^[0-9a-zA-Z.\-]+$/.test(address) || /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
  const portOk = !port || /^[0-9]{1,5}$/.test(port);
  const url = () => `${ssl ? 'https' : 'http'}://${address}${port ? `:${port}` : ''}${path}`;
  const save = async () => {
    if (!addrOk) return showAlert({ content: t('error_text_node_address') });
    if (!portOk) return showAlert({ content: t('error_text_node_port') });
    const node: Node = { id: ex && !ex.builtin ? ex.id : `custom:${crypto.randomUUID()}`, type: args.type, kind, url: url(), label: label || undefined, login: login || undefined, password: password || undefined, trusted, pow: !!args.pow };
    const local = /^(127\.|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || address.endsWith('.local');
    if (local) {
      const origin = new URL(node.url).origin;
      const prev = (await db.get<string[]>('kv', 'net:localNodes')) ?? [];
      if (!prev.includes(origin)) {
        await db.put('kv', 'net:localNodes', [...prev, origin]);
        net().configure({ localNodes: [...prev, origin] });
      }
    }
    customNodes.value = [...customNodes.value.filter((n) => n.id !== node.id), node];
    await saveNodes();
    nav.pop(node);
  };
  return (
    <Page
      title={ex ? t('edit_node') : t('node_new')}
      solid
      id="node_form_page"
      trailing={editable ? <ModernButton icon="check" size={36} label={t('save')} id="node_save" onClick={() => void save()} /> : undefined}
      footer={
        <div class="col gap8">
          {testResult && <div class="center muted">{testResult}</div>}
          <Button secondary onClick={async () => {
            setTestResult('…');
            try {
              const ms = await testNode({ id: 'test', type: args.type, kind, url: url(), login, password });
              setTestResult(`${t('connected')} (${Math.round(ms)} ms)`);
            } catch (e) {
              setTestResult(`${t('sync_offline')}: ${(e as Error).message}`);
            }
          }}>{t('node_test')}</Button>
          {ex && editable && <Button danger onClick={async () => {
            if (!(await confirmAlert(t('remove_node'), t('remove_node_message'), t('remove')))) return;
            customNodes.value = customNodes.value.filter((n) => n.id !== ex.id);
            await saveNodes();
            nav.pop();
          }}>{t('delete_this_node')}</Button>}
        </div>
      }
    >
      <div class="col gap12">
        {editable && (
          <>
            <Field value={label} onInput={setLabel} placeholder="Node label" />
            <Field value={address} onInput={setAddress} placeholder={t('node_address')} error={address && !addrOk ? t('error_text_node_address') : null} id="node_address" />
            <Field value={port} onInput={setPort} placeholder={t('node_port')} inputMode="numeric" maxLength={5} error={!portOk ? t('error_text_node_port') : null} id="node_port" />
            <Field value={path} onInput={setPath} placeholder="/path" id="node_path" />
            {(args.type === 'monero' || args.type === 'wownero') && (
              <>
                <Field value={login} onInput={setLogin} placeholder={t('login')} />
                <Field value={password} onInput={setPassword} placeholder={t('password')} type="password" />
              </>
            )}
            {(args.type === 'bitcoin' || args.type === 'litecoin' || args.type === 'bitcoinCash' || args.type === 'dogecoin') && (
              <Section>
                <Row label="API" trailingText={kind === 'esplora' ? 'Esplora (mempool / electrs)' : kind === 'blockbook' ? 'Blockbook' : 'Blockchair'} onClick={async () => {
                  const v = await pickOption('API', [{ id: 'esplora', label: 'Esplora (mempool / electrs)' }, { id: 'blockbook', label: 'Blockbook' }], kind);
                  if (v) setKind(v as NodeKind);
                }} />
              </Section>
            )}
          </>
        )}
        <Section>
          <ToggleRow label={t('use_ssl')} value={ssl} onChange={setSsl} />
          {(args.type === 'monero' || args.type === 'wownero') && <ToggleRow label={t('trusted')} value={trusted} onChange={setTrusted} />}
        </Section>
        <div class="info-box">All connections go through Tor. A node on this computer or your local network (127.0.0.1, 192.168.x.x, *.local) is reached directly instead, since Tor cannot reach private networks; it must allow cross-origin requests from this site.</div>
      </div>
    </Page>
  );
}

function TorSettingsPage() {
  const [text, setText] = useState('');
  const [current, setCurrent] = useState<string[]>([]);
  useEffect(() => {
    void db.get<string[]>('kv', 'tor:relays').then((r) => setText((r ?? []).join('\n')));
    void effectiveRelays().then(setCurrent);
  }, []);
  const s = torStatus.value;
  return (
    <Page title="Tor" solid id="tor_settings_page" footer={
      <Button id="tor_relays_save" onClick={async () => {
        const list = text.split('\n').map((x) => x.trim()).filter(Boolean);
        try {
          await setUserRelays(list);
          await net().startTor();
          toast(t('saved') === 'saved' ? 'Saved' : t('saved'));
          setCurrent(await effectiveRelays());
        } catch (e) {
          await showAlert({ title: 'Tor', content: (e as Error).message });
        }
      }}>{t('save')}</Button>
    }>
      <div class="col gap16">
        <div class="card col gap8">
          <div class="rowx gap8"><img src="./cake/new-ui/tor.svg" alt="" style={{ width: '20px' }} /><b>{s.state === 'ready' ? t('connected') : s.message}</b></div>
          {s.via && <div class="muted">via {s.via}</div>}
          <div class="muted" style={{ fontSize: '12px' }}>The Tor client (Arti, compiled to WebAssembly) runs inside this page and builds its own circuits. Browsers cannot open TCP connections, so it reaches the first Tor relay through an entry point: a tor-js gateway (WebRTC) or a WebSocket bridge. The entry point only sees encrypted Tor traffic and your IP address, like any Tor guard.</div>
        </div>
        <div>
          <div class="field-label">Tor relay entry points (one per line, empty = defaults)</div>
          <textarea class="text-area-plain mono" style={{ fontSize: '13px' }} value={text} placeholder={BUILTIN_RELAYS.join('\n')} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} id="tor_relays" />
          <div class="field-hint">tor-js gateway: <span class="mono">ip:port:certhash</span> · WebSocket bridge: <span class="mono">wss://host/tor</span></div>
        </div>
        <Section header="In use">
          {current.map((r) => <Row label={<span class="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>{r}</span>} />)}
        </Section>
        <Button secondary onClick={() => { net().newIdentity(); toast('New Tor circuits for all further requests'); }}>New identity (new circuits)</Button>
      </div>
    </Page>
  );
}

function NetworkActivityPage() {
  const [, force] = useState(0);
  useEffect(() => net().onActivity(() => force((x) => x + 1)), []);
  const list = [...net().activity].reverse().slice(0, 200);
  return (
    <Page title="Network activity" solid id="network_activity_page">
      <div class="muted" style={{ fontSize: '12px', marginBottom: '12px' }}>Every request this app made, and the route it took. "tor" = through the in-page Tor client; "local" = your own node on this computer/LAN.</div>
      <div class="list">
        {list.map((a) => (
          <div class="row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }}>
            <span style={{ fontSize: '12px' }}><b style={{ color: a.via === 'tor' ? 'var(--tor-purple)' : a.via === 'blocked' ? 'var(--error)' : 'var(--primary)' }}>{a.via}</b> {a.method} {a.host}{a.path}</span>
            <span class="muted" style={{ fontSize: '11px' }}>{new Date(a.at).toLocaleTimeString()} · {a.purpose ?? ''} {a.status ? `· ${a.status}` : ''} {a.ms ? `· ${a.ms} ms` : ''} {a.error ? `· ${a.error}` : ''}</span>
          </div>
        ))}
      </div>
    </Page>
  );
}

const KEY_PROVIDERS: { id: string; label: string; hint: string }[] = [
  { id: 'changenow', label: 'ChangeNOW', hint: 'x-changenow-api-key' },
  { id: 'trocador', label: 'Trocador', hint: 'API key' },
  { id: 'chainflip', label: 'Chainflip broker', hint: 'broker API key' },
  { id: 'swapsxyz', label: 'Swaps.xyz', hint: 'x-api-key' },
  { id: 'whynot', label: 'WhyNot', hint: 'API key' },
  { id: 'etherscan', label: 'Etherscan', hint: 'Etherscan V2 API key (EVM history)' },
  { id: 'moralis', label: 'Moralis', hint: 'NFTs, token metadata' },
  { id: 'trongrid', label: 'TronGrid', hint: 'TRON-PRO-API-KEY' },
  { id: 'onramper', label: 'Onramper', hint: 'Buy/Sell' },
  { id: 'moonpay', label: 'MoonPay', hint: 'publishable key' },
  { id: 'cakepay', label: 'Cake Pay', hint: 'API key' },
  { id: 'walletconnect', label: 'WalletConnect', hint: 'Reown project id' },
  { id: 'twitter', label: 'X (Twitter)', hint: 'bearer token (address lookups)' },
];

function ApiKeysPage() {
  const keys = settings.value.apiKeys;
  return (
    <Page title="API keys" solid id="api_keys_page">
      <div class="info-box" style={{ marginBottom: '16px' }}>Some services need an API key. The official app ships Cake Labs' keys inside the app; a public web page cannot keep a key secret, so this client never ships one. Services that need a key stay off until you add your own here. Keys are stored encrypted and only ever sent to that service, over Tor.</div>
      <div class="col gap12">
        {KEY_PROVIDERS.map((p) => (
          <Field label={p.label} value={keys[p.id] ?? ''} onInput={(v) => updateSettings((s) => ({ apiKeys: { ...s.apiKeys, [p.id]: v.trim() } }))} placeholder={p.hint} type="password" id={`api_key_${p.id}`} />
        ))}
      </div>
    </Page>
  );
}

registerRoute(Routes.connectionSync, ConnectionsPage);
registerRoute(Routes.domainLookupsPage, DomainLookupsPage);
registerRoute(Routes.manageNodes, ManageNodesPage);
registerRoute(Routes.managePowNodes, (p: any) => <ManageNodesPage args={{ ...(p.args ?? {}), pow: true }} />);
registerRoute(Routes.newNode, NodeFormPage);
registerRoute(Routes.newPowNode, (p: any) => <NodeFormPage args={{ ...(p.args ?? {}), pow: true }} />);
registerRoute(Routes.torSettings, TorSettingsPage);
registerRoute(Routes.devNetworkRequests, NetworkActivityPage);
registerRoute(Routes.apiKeysPage, ApiKeysPage);
