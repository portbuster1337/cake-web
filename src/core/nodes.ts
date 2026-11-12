// Nodes: Cake's node model (cw_core/lib/node.dart) generalised for the web.
// Each wallet type has a list of nodes and a current node. Built-in defaults
// follow Cake's lists where the server speaks HTTP; for the Electrum coins
// (raw TCP, unreachable from a browser) they are the HTTP indexers that the
// same operators run (Cake's own mempool instance for Bitcoin).

import { signal } from '@preact/signals';
import type { WalletType } from '../coins/types.ts';

export type NodeKind = 'esplora' | 'blockbook' | 'blockchair' | 'monerod' | 'evm' | 'solana' | 'tron' | 'nano' | 'nanoPow' | 'decred' | 'zcash' | 'zano';

export interface Node {
  id: string;
  type: WalletType;
  kind: NodeKind;
  /** full base URL incl. scheme and path */
  url: string;
  label?: string;
  login?: string;
  password?: string;
  trusted?: boolean;
  isDefault?: boolean;
  builtin?: boolean;
  /** Blockchair chain slug */
  chain?: string;
  /** for nano: this is a PoW (work_generate) node */
  pow?: boolean;
}

const B = (type: WalletType, kind: NodeKind, url: string, extra: Partial<Node> = {}): Node => ({ id: `builtin:${type}:${url}`, type, kind, url, builtin: true, ...extra });

export const BUILTIN_NODES: Node[] = [
  // Monero (assets/node_list.yml): Cake's node first (default, trusted), its onion, then the community nodes
  B('monero', 'monerod', 'https://xmr-node.cakewallet.com:18081', { isDefault: true, trusted: true, label: 'Cake Wallet' }),
  B('monero', 'monerod', 'http://cakexmrkbd7ptshw7vfzhzqgg77xgeavdrxm6zbu57lppfkj3fczbrqd.onion:18081', { label: 'Cake Wallet (onion)' }),
  B('monero', 'monerod', 'https://node.sethforprivacy.com:443'),
  B('monero', 'monerod', 'https://node.monerodevs.org:18089'),
  B('monero', 'monerod', 'https://node2.monerodevs.org:18089'),
  B('monero', 'monerod', 'https://node3.monerodevs.org:18089'),
  B('monero', 'monerod', 'https://selsta1.featherwallet.net:18081'),
  B('monero', 'monerod', 'https://xmr.stormycloud.org:18089'),
  // Bitcoin: Cake's mempool.space instance (Esplora API) over its onion service
  B('bitcoin', 'esplora', 'http://cakememcninjdqbaub3tp2iswuigxqtdoevnpgzkolmy4gvhrrsub3yd.onion/api', { isDefault: true, label: 'Cake Wallet (onion)' }),
  B('bitcoin', 'esplora', 'https://mempool.cakewallet.com/api', { label: 'Cake Wallet' }),
  B('bitcoin', 'esplora', 'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api', { label: 'mempool.space (onion)' }),
  B('bitcoin', 'esplora', 'https://blockstream.info/api', { label: 'Blockstream' }),
  B('bitcoin', 'blockbook', 'https://btc1.trezor.io', { label: 'Trezor' }),
  // Litecoin
  B('litecoin', 'esplora', 'https://litecoinspace.org/api', { isDefault: true, label: 'litecoinspace.org' }),
  B('litecoin', 'blockbook', 'https://litecoinblockexplorer.net', { label: 'litecoinblockexplorer.net' }),
  B('litecoin', 'blockbook', 'https://ltc1.trezor.io', { label: 'Trezor' }),
  // Bitcoin Cash
  B('bitcoinCash', 'blockbook', 'https://bchblockexplorer.com', { isDefault: true, label: 'bchblockexplorer.com' }),
  B('bitcoinCash', 'blockbook', 'https://bch1.trezor.io', { label: 'Trezor' }),
  B('bitcoinCash', 'blockchair', 'https://api.blockchair.com', { chain: 'bitcoin-cash', label: 'Blockchair' }),
  // Dogecoin
  B('dogecoin', 'blockbook', 'https://doge1.trezor.io', { isDefault: true, label: 'Trezor' }),
  B('dogecoin', 'blockchair', 'https://api.blockchair.com', { chain: 'dogecoin', label: 'Blockchair' }),
  // EVM (assets/*_node_list.yml, keyless entries)
  B('ethereum', 'evm', 'https://ethereum-rpc.publicnode.com', { isDefault: true }),
  B('ethereum', 'evm', 'https://eth.llamarpc.com'),
  B('ethereum', 'evm', 'https://rpc.flashbots.net'),
  B('ethereum', 'evm', 'https://eth-mainnet.public.blastapi.io'),
  B('polygon', 'evm', 'https://polygon-bor-rpc.publicnode.com', { isDefault: true }),
  B('polygon', 'evm', 'https://polygon-rpc.com'),
  B('base', 'evm', 'https://base-rpc.publicnode.com', { isDefault: true }),
  B('base', 'evm', 'https://base.llamarpc.com'),
  B('base', 'evm', 'https://1rpc.io/base'),
  B('arbitrum', 'evm', 'https://arbitrum-one-rpc.publicnode.com', { isDefault: true }),
  B('arbitrum', 'evm', 'https://arbitrum.drpc.org'),
  B('bsc', 'evm', 'https://bsc-dataseed.bnbchain.org', { isDefault: true }),
  B('bsc', 'evm', 'https://bsc-dataseed2.bnbchain.org'),
  B('bsc', 'evm', 'https://bsc-dataseed.defibit.io'),
  B('bsc', 'evm', 'https://bsc-dataseed.ninicoin.io'),
  B('bsc', 'evm', 'https://bsc-dataseed-public.bnbchain.org'),
  B('robinhood', 'evm', 'https://robinhood-rpc.publicnode.com', { isDefault: true }),
  B('robinhood', 'evm', 'https://rpc.mainnet.chain.robinhood.com'),
  // Solana / Tron
  B('solana', 'solana', 'https://api.mainnet-beta.solana.com', { isDefault: true }),
  B('solana', 'solana', 'https://solana-rpc.publicnode.com'),
  B('tron', 'tron', 'https://api.trongrid.io', { isDefault: true }),
  B('tron', 'tron', 'https://tron-rpc.publicnode.com'),
  // Nano (+ PoW nodes)
  B('nano', 'nano', 'https://rpc.nano.to', { isDefault: true }),
  B('nano', 'nano', 'https://node.nautilus.io/api'),
  B('nano', 'nano', 'https://app.natrium.io/api'),
  B('nano', 'nano', 'https://rainstorm.city/api'),
  B('nano', 'nano', 'https://node.somenano.com/proxy'),
  B('nano', 'nano', 'https://nanoslo.0x.no/proxy'),
  B('nano', 'nanoPow', 'https://rpc.nano.to', { isDefault: true, pow: true }),
  B('nano', 'nanoPow', 'https://worker.nanoriver.cc', { pow: true }),
];

export const customNodes = signal<Node[]>([]);
export const currentNodeIds = signal<Partial<Record<string, string>>>({});

export function nodesFor(type: WalletType, pow = false): Node[] {
  return [...BUILTIN_NODES, ...customNodes.value].filter((n) => n.type === type && !!n.pow === pow);
}

export function currentNode(type: WalletType, pow = false): Node {
  const list = nodesFor(type, pow);
  const id = currentNodeIds.value[pow ? `${type}:pow` : type];
  const n = list.find((x) => x.id === id) ?? list.find((x) => x.isDefault) ?? list[0];
  if (!n) throw new Error(`No node configured for ${type}`);
  return n;
}

export function setCurrentNode(type: WalletType, id: string, pow = false): void {
  currentNodeIds.value = { ...currentNodeIds.value, [pow ? `${type}:pow` : type]: id };
}

export function nodeHost(n: Node): string {
  try {
    const u = new URL(n.url);
    return u.host;
  } catch {
    return n.url;
  }
}
