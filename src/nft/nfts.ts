// The NFT view model (lib/view_model/dashboard/nft_view_model.dart): the
// wallet's NFTs from Moralis (with the user's key) plus the ones imported by
// hand, Solana details batched by five with the on-chain Metaplex metadata as
// the fallback, one fetch at a time, and imports. Cake's Moralis key is not
// available here: without the user's own, EVM lists come from Blockscout and
// Solana lists from the token accounts the wallet holds, and EVM imports read
// the token's contract — no key needed, all over Tor.

import { signal } from '@preact/signals';
import { t } from '../core/i18n.ts';
import { currentWallet, walletCache } from '../app/app.ts';
import { apiKey } from '../exchange/keys.ts';
import { getJson, router } from '../net/http.ts';
import { normalizeIpfsUrl } from '../net/ipfs.ts';
import { fetchRemote } from '../net/remote.ts';
import { decodeString, encodeCall, isValidEvmAddress, selectorOf } from '../coins/evm/eth.ts';
import type { PendingTransaction, WalletBase } from '../core/wallet.ts';
import {
  dataUriJson, erc1155Uri, evmRow, isNftChain, keepFromPrevious, mergeEvm, nftChainName, parseBlockscoutNft, parseNftAsset, parseSolanaNft, sanitizeNftText,
  saveRow, savedEvm, savedSolana, solanaNft, solanaRow, updateRow, SOLANA_CHAIN, type NftAsset, type SavedNft, type SolanaNft,
} from './models.ts';

const MORALIS = 'https://deep-index.moralis.io/api/v2.2';
const MORALIS_SOLANA = 'https://solana-gateway.moralis.io';
/** Cake: 20 s per request and 2 minutes per Solana refresh; Tor needs longer */
const REQUEST_TIMEOUT = 45_000;
const RUN_DEADLINE = 240_000;
const SAVED = 'nfts';
const METADATA_MAX = 256 * 1024;

const SEL = { tokenURI: selectorOf('tokenURI(uint256)'), uri: selectorOf('uri(uint256)'), name: selectorOf('name()'), symbol: selectorOf('symbol()') };

/** what the NFT pages need from a Solana wallet */
export interface SolanaNftWallet extends WalletBase {
  address: string;
  heldTokenMints(): Promise<{ held: Set<string>; nftLike: string[] }>;
  nftOnChainMetadata(mint: string): Promise<{ mint: string; name: string; symbol: string; metadataUri: string; imageUrl: string | null } | null>;
  createNftTransaction(mint: string, to: string, meta?: { name?: string }): Promise<PendingTransaction>;
}

/** … and from an EVM wallet */
interface EvmNftWallet extends WalletBase {
  address: string;
  chainId: number;
  chain: { blockscout?: string };
  callContract(to: string, data: Uint8Array): Promise<string>;
}

export type NftSource = 'moralis' | 'blockscout' | 'chain' | 'none';

const chainIdOf = (w: WalletBase): number | null => {
  const id = (w as Partial<EvmNftWallet>).chainId;
  return typeof id === 'number' ? id : null;
};
const addressOf = (w: WalletBase | null | undefined): string | null => (w ? (w as Partial<EvmNftWallet>).address ?? w.receiveAddress.peek() : null);
const scopeOf = (w: WalletBase) => `wallet:${w.id}`;
const moralisHeaders = (key: string) => ({ Accept: 'application/json', 'X-API-Key': key });

export const isNftWallet = (w: WalletBase): boolean => isNftChain(w.type, chainIdOf(w));

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('NFT refresh timed out')), ms))]);
}

/** a 2xx answer as JSON, else an error (NFTResponseException) */
async function moralisJson<T>(url: string, key: string, scope: string, purpose: string): Promise<T> {
  return getJson<T>(url, { headers: moralisHeaders(key), scope, timeoutMs: REQUEST_TIMEOUT, retries: 1, purpose });
}

/** Blockscout's NFT list (two pages at most, as Moralis's one page of 100); Cloudflare turns some exits away */
async function blockscoutNfts(base: string, address: string, scope: string): Promise<NftAsset[]> {
  const out: NftAsset[] = [];
  const type = 'ERC-721,ERC-404,ERC-1155';
  let params: Record<string, string> | null = { type };
  for (let page = 0; params && page < 2; page++) {
    const url = `${base}/v2/addresses/${address}/nft?${new URLSearchParams(params)}`;
    let j: any;
    for (let attempt = 0; ; attempt++) {
      try {
        j = await getJson<any>(url, { scope, timeoutMs: REQUEST_TIMEOUT, retries: 1, purpose: 'NFTs' });
        break;
      } catch (e) {
        if ((e as { status?: number })?.status !== 403 || attempt >= 2) throw e;
        router().rotateIsolation(url, scope);
      }
    }
    for (const it of Array.isArray(j?.items) ? j.items : []) {
      const a = parseBlockscoutNft(it);
      if (a) out.push(a);
    }
    const next = j?.next_page_params;
    params = next && typeof next === 'object' ? { type, ...Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])) } : null;
  }
  return out;
}

/** a token's metadata JSON from its URI: inline (data:), else over https or IPFS (at most 256 KiB); null when there is none */
async function metadataJson(uri: string, scope: string): Promise<any> {
  const inline = dataUriJson(uri);
  if (inline) return inline;
  const url = normalizeIpfsUrl(uri);
  if (!url) return null;
  try {
    const r = await fetchRemote(url, { scope, maxBytes: METADATA_MAX, timeoutMs: 30_000, purpose: 'nft metadata' });
    return JSON.parse(new TextDecoder().decode(r.body));
  } catch {
    return null;
  }
}

const callString = async (w: EvmNftWallet, to: string, selector: string): Promise<string | null> => {
  try {
    return decodeString(await w.callContract(to, encodeCall(selector))) || null;
  } catch {
    return null;
  }
};

/** an NFT read from its contract: ERC-721 tokenURI, else ERC-1155 uri, the contract's name and symbol, the metadata */
async function contractNft(w: EvmNftWallet, contract: string, tokenIdText: string, scope: string): Promise<NftAsset> {
  if (!isValidEvmAddress(contract)) throw new Error('Invalid contract address');
  const id = BigInt(tokenIdText.trim());
  if (id < 0n) throw new Error('Invalid token ID');
  let uri: string | null = null;
  let type = 'ERC721';
  try {
    uri = decodeString(await w.callContract(contract, encodeCall(SEL.tokenURI, [{ uint: id }]))) || null;
  } catch { /* not ERC-721 */ }
  if (!uri) {
    try {
      const u = decodeString(await w.callContract(contract, encodeCall(SEL.uri, [{ uint: id }])));
      if (u) {
        uri = erc1155Uri(u, id);
        type = 'ERC1155';
      }
    } catch { /* not ERC-1155 */ }
  }
  if (!uri) throw new Error('Not an NFT contract');
  const [name, symbol, meta] = await Promise.all([callString(w, contract, SEL.name), callString(w, contract, SEL.symbol), metadataJson(uri, scope)]);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    tokenAddress: contract.toLowerCase(),
    tokenId: id.toString(),
    contractType: type,
    name: sanitizeNftText(name),
    symbol: sanitizeNftText(symbol),
    normalizedMetadata: meta && typeof meta === 'object' ? { name: sanitizeNftText(meta.name), description: sanitizeNftText(meta.description), image: str(meta.image) ?? str(meta.image_url) } : null,
  };
}

export class NftViewModel {
  readonly isLoading = signal(false);
  readonly isImportLoading = signal(false);
  readonly unresolvedCount = signal(0);
  readonly evmAssets = signal<NftAsset[]>([]);
  readonly solanaAssets = signal<SolanaNft[]>([]);
  /** where the last list came from */
  readonly source = signal<NftSource>('none');
  /** the bottom sheet message (BottomSheetService.queueBottomSheet) */
  onError: (message: string) => void = () => {};
  #walletId: string | null = null;
  #loadedWalletAddress: string | null = null;
  #refreshId = 0;
  #errorShown = false;
  #last: Promise<void> = Promise.resolve();
  #queued: Promise<void> | null = null;

  get isSolanaWallet(): boolean {
    return currentWallet.peek()?.type === 'solana';
  }

  /** onWalletChanged: another wallet's NFTs are not shown while its own load */
  onWalletChanged(): void {
    this.evmAssets.value = [];
    this.solanaAssets.value = [];
    this.unresolvedCount.value = 0;
    this.#errorShown = false;
  }

  /** the listing opened (or the wallet changed): a fetch, after the one running, at most one waiting */
  load(w: WalletBase): Promise<void> {
    if (this.#walletId !== w.id) {
      this.#walletId = w.id;
      this.onWalletChanged();
    }
    return this.getNftAssets();
  }

  /** getNFTAssetByWallet */
  getNftAssets(): Promise<void> {
    if (this.#queued) return this.#queued;
    let done!: () => void;
    const p = new Promise<void>((ok) => (done = ok));
    this.#queued = p;
    const waitFor = this.#last;
    this.#last = p;
    void this.#fetchAfterPreviousRun(waitFor, p, done);
    return p;
  }

  async #fetchAfterPreviousRun(waitFor: Promise<void>, self: Promise<void>, done: () => void): Promise<void> {
    await waitFor;
    if (this.#queued === self) this.#queued = null;
    try {
      const w = currentWallet.peek();
      if (!w || !isNftWallet(w)) return;
      const address = addressOf(w)!;
      const chainName = nftChainName(w.type, chainIdOf(w));
      this.isLoading.value = true;
      const refreshId = ++this.#refreshId;
      if (w.type === 'solana') await withDeadline(this.#solana(w as SolanaNftWallet, address, chainName, refreshId), RUN_DEADLINE);
      else await this.#evm(w as EvmNftWallet, address, chainName, refreshId);
      this.#errorShown = false;
    } catch {
      if (!this.#errorShown) {
        this.#errorShown = true;
        this.onError(t('moralis_nft_error'));
      }
    } finally {
      this.isLoading.value = false;
      done();
    }
  }

  #stale(address: string, refreshId: number): boolean {
    return addressOf(currentWallet.peek()) !== address || refreshId !== this.#refreshId;
  }

  // ------------------------------------------------------------------ EVM --

  async #evm(w: EvmNftWallet, address: string, chainName: string, refreshId: number): Promise<void> {
    const saved = savedEvm(await this.#rows(w.id), chainName);
    let result: NftAsset[] = [];
    let indexerError: unknown = null;
    try {
      result = await this.#listEvm(w, address, chainName);
    } catch (e) {
      indexerError = e;
    }
    if (this.#stale(address, refreshId)) return;
    this.evmAssets.value = mergeEvm(result, saved);
    if (indexerError) throw indexerError;
  }

  async #listEvm(w: EvmNftWallet, address: string, chainName: string): Promise<NftAsset[]> {
    const key = apiKey('moralis');
    if (key) {
      this.source.value = 'moralis';
      const q = new URLSearchParams({ chain: chainName, format: 'decimal', media_items: 'false', exclude_spam: 'true', normalizeMetadata: 'true' });
      const j = await moralisJson<any>(`${MORALIS}/${address}/nft?${q}`, key, scopeOf(w), 'NFTs');
      return (Array.isArray(j?.result) ? j.result : []).map(parseNftAsset);
    }
    if (!w.chain.blockscout) {
      this.source.value = 'none';
      return [];
    }
    this.source.value = 'blockscout';
    return blockscoutNfts(w.chain.blockscout, address, scopeOf(w));
  }

  // --------------------------------------------------------------- Solana --

  async #solana(w: SolanaNftWallet, address: string, chainName: string, refreshId: number): Promise<void> {
    const imported = savedSolana(await this.#rows(w.id));
    const key = apiKey('moralis');
    let indexerMints: string[] = [];
    let indexerError: unknown = null;
    let held: Set<string> | null = null;
    let nftLike: string[] = [];
    try {
      ({ held, nftLike } = await w.heldTokenMints());
    } catch {
      held = null;
    }
    if (key) {
      this.source.value = 'moralis';
      try {
        indexerMints = await this.#mintsFromIndexer(address, chainName, key, scopeOf(w));
      } catch (e) {
        indexerError = e;
      }
    } else {
      // no indexer: the mints the wallet holds as one unit without decimals
      this.source.value = 'chain';
      if (held === null) indexerError = new Error('Could not read the token accounts');
      indexerMints = nftLike;
    }
    const failed = new Set<string>();
    const assets = await this.#loadAssetsForMints(w, chainName, [...new Set([...indexerMints, ...imported.keys()])], held, imported, failed, key);
    if (this.#stale(address, refreshId)) return;
    if (this.#loadedWalletAddress === address) assets.push(...keepFromPrevious(this.solanaAssets.peek(), assets, failed, indexerError !== null));
    this.solanaAssets.value = assets;
    this.#loadedWalletAddress = address;
    const shown = new Set(assets.map((a) => a.mint));
    this.unresolvedCount.value = [...failed].filter((m) => !shown.has(m)).length;
    // SavedNFTs.refreshSolana: the saved rows get the fresh details
    if (held !== null) {
      let rows = await this.#rows(w.id);
      for (const a of assets) if (a.mint) rows = updateRow(rows, solanaRow(a.mint, a));
      await walletCache.put(w.id, SAVED, rows);
    }
    if (indexerError) throw indexerError;
  }

  async #mintsFromIndexer(address: string, chainName: string, key: string, scope: string): Promise<string[]> {
    const j = await moralisJson<any>(`${MORALIS_SOLANA}/account/${chainName}/${address}/nft`, key, scope, 'NFTs');
    return (Array.isArray(j) ? j : []).map((e: any) => (typeof e?.mint === 'string' ? e.mint : '')).filter((m: string) => m);
  }

  /** _loadAssetsForMints: five at a time; a mint that fails keeps its saved details */
  async #loadAssetsForMints(w: SolanaNftWallet, chainName: string, mints: string[], held: Set<string> | null, imported: Map<string, SolanaNft>, failed: Set<string>, key: string): Promise<SolanaNft[]> {
    const out: SolanaNft[] = [];
    for (let i = 0; i < mints.length; i += 5) {
      const described = await Promise.all(
        mints.slice(i, i + 5).map(async (mint) => {
          try {
            const asset = await this.solanaDetails(w, mint, chainName, key);
            asset.isOwned = held ? held.has(mint) : imported.get(mint)?.isOwned ?? null;
            return asset;
          } catch {
            failed.add(mint);
            const cached = imported.get(mint);
            if (cached && held) cached.isOwned = held.has(mint);
            return cached ?? null;
          }
        }),
      );
      for (const a of described) if (a) out.push(a);
    }
    return out;
  }

  /** getSolanaNFTDetails: Moralis's details; without an image there, the image of the on-chain metadata; else on-chain only */
  async solanaDetails(w: SolanaNftWallet, mint: string, chainName: string, key = apiKey('moralis')): Promise<SolanaNft> {
    let asset: SolanaNft | null = null;
    if (key) {
      try {
        const j = await moralisJson<any>(`${MORALIS_SOLANA}/nft/${chainName}/${mint}/metadata`, key, scopeOf(w), 'NFT details');
        asset = { ...parseSolanaNft(j), address: mint, mint };
      } catch { /* the chain */ }
    }
    if (asset?.imageOriginalUrl) return asset;
    const onChain = await w.nftOnChainMetadata(mint);
    if (asset) {
      if (onChain) asset.imageOriginalUrl = normalizeIpfsUrl(onChain.imageUrl);
      return asset;
    }
    if (!onChain) throw new Error(`Could not load NFT metadata for ${mint}`);
    return solanaNft({ address: mint, mint, standard: 'metaplex', name: onChain.name, symbol: onChain.symbol, imageOriginalUrl: onChain.imageUrl, metadataOriginalUrl: onChain.metadataUri });
  }

  // --------------------------------------------------------------- import --

  /** importNFT: a Solana mint, or an EVM contract and token ID; the NFT is saved for the wallet */
  async importNft(tokenAddress: string, tokenId: string): Promise<void> {
    const w = currentWallet.peek();
    if (!w) return;
    const chainName = nftChainName(w.type, chainIdOf(w));
    const address = tokenAddress.trim();
    try {
      this.isImportLoading.value = true;
      if (w.type === 'solana') {
        const sw = w as SolanaNftWallet;
        const result = await this.solanaDetails(sw, address, chainName);
        try {
          result.isOwned = (await sw.heldTokenMints()).held.has(result.mint ?? '');
        } catch { /* unknown */ }
        this.solanaAssets.value = [...this.solanaAssets.peek().filter((a) => a.mint !== result.mint), result];
        if (result.mint) await this.#save(w.id, solanaRow(result.mint, result));
      } else {
        const key = apiKey('moralis');
        let asset: NftAsset;
        if (key) {
          const q = new URLSearchParams({ chain: chainName, format: 'decimal', media_items: 'false', normalizeMetadata: 'true' });
          asset = parseNftAsset(await moralisJson<any>(`${MORALIS}/nft/${address}/${tokenId.trim()}?${q}`, key, scopeOf(w), 'NFT import'));
          if (!asset.tokenAddress) throw new Error('No such NFT');
        } else asset = await contractNft(w as EvmNftWallet, address, tokenId, scopeOf(w));
        this.evmAssets.value = [...this.evmAssets.peek(), asset];
        const row = evmRow(chainName, asset);
        if (row) await this.#save(w.id, row);
      }
    } catch {
      this.onError(t('nft_import_failed'));
    } finally {
      this.isImportLoading.value = false;
    }
  }

  /** onNFTSent: the NFT leaves the wallet's list and its saved rows */
  async onNftSent(walletId: string, mint: string): Promise<void> {
    const rows = await this.#rows(walletId);
    await walletCache.put(walletId, SAVED, rows.filter((r) => r.chain !== SOLANA_CHAIN || r.identifier !== mint));
    if (currentWallet.peek()?.id === walletId) this.solanaAssets.value = this.solanaAssets.peek().filter((a) => a.mint !== mint);
  }

  async #rows(walletId: string): Promise<SavedNft[]> {
    return (await walletCache.get<SavedNft[]>(walletId, SAVED)) ?? [];
  }

  async #save(walletId: string, row: SavedNft): Promise<void> {
    await walletCache.put(walletId, SAVED, saveRow(await this.#rows(walletId), row));
  }
}

export const nftViewModel = new NftViewModel();
