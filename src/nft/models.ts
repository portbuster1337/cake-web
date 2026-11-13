// NFT models (lib/entities/wallet_nft_response.dart, solana_nft_asset_model.dart,
// saved_nfts.dart, cw_core/lib/imported_nft.dart, cw_core/lib/utils/nft_text.dart).

import { normalizeIpfsUrl } from '../net/ipfs.ts';
import type { WalletType } from '../coins/types.ts';

// Control characters and bidi overrides let a mint's own metadata fake extra
// lines or reverse the text around it wherever the name is shown.
const UNSAFE = /[\u0000-\u001F\u007F\u00AD\u034F\u061C\u115F\u1160\u180E\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}]/gu;
const MAX_TEXT = 512;

/** sanitizeNFTText: unsafe characters become spaces, trimmed, at most 512 characters (then "…") */
export function sanitizeNftText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(UNSAFE, ' ').trim();
  const runes = [...cleaned];
  return runes.length <= MAX_TEXT ? cleaned : `${runes.slice(0, MAX_TEXT).join('')}\u2026`;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

// ----------------------------------------------------------------- chains --

/** isNFTACtivatedChain: Ethereum, Base, Polygon, Arbitrum, BNB Smart Chain and Solana */
export function isNftChain(type: WalletType, chainId?: number | null): boolean {
  if (chainId !== null && chainId !== undefined) return [1, 8453, 137, 42161, 56].includes(chainId);
  return type === 'solana';
}

/** getChainNameBasedOnWalletType: Moralis's chain name (Solana: "mainnet"; EVM: the chain's short code) */
export function nftChainName(type: WalletType, chainId?: number | null): string {
  if (type === 'solana') return 'mainnet';
  return ({ 1: 'eth', 137: 'polygon', 8453: 'base', 42161: 'arbitrum', 56: 'bsc', 4663: 'robinhood' } as Record<number, string>)[chainId ?? 1] ?? 'eth';
}

/** ImportedNFT.solanaChain: the saved rows' chain of Solana NFTs */
export const SOLANA_CHAIN = 'solana';

// -------------------------------------------------------------------- EVM --

export interface NormalizedMetadata {
  name: string | null;
  description: string | null;
  image: string | null;
}

/** NFTAssetModel */
export interface NftAsset {
  tokenAddress: string | null;
  tokenId: string | null;
  contractType: string | null;
  name: string | null;
  symbol: string | null;
  normalizedMetadata: NormalizedMetadata | null;
}

/** NormalizedMetadata.imageUrl */
export const nftImageUrl = (a: NftAsset): string | null => normalizeIpfsUrl(a.normalizedMetadata?.image);

/** NFTAssetModel.fromJson (Moralis) */
export function parseNftAsset(json: any): NftAsset {
  const m = json?.normalized_metadata;
  return {
    tokenAddress: str(json?.token_address),
    tokenId: str(json?.token_id),
    contractType: str(json?.contract_type),
    name: sanitizeNftText(json?.name),
    symbol: sanitizeNftText(json?.symbol),
    normalizedMetadata: m && typeof m === 'object' ? { name: sanitizeNftText(m.name), description: sanitizeNftText(m.description), image: str(m.image) } : null,
  };
}

/** SavedNFTs.evmIdentifier: "<token address>:<token id>" */
export function evmIdentifier(a: NftAsset): string | null {
  if (!a.tokenAddress) return null;
  return `${a.tokenAddress}:${a.tokenId ?? ''}`;
}

// ----------------------------------------------------------------- Solana --

export interface SolanaCollection {
  collectionAddress: string | null;
  name: string | null;
  description: string | null;
  imageOriginalUrl: string | null;
  externalUrl: string | null;
  metaplexMint: string | null;
  sellerFeeBasisPoints: number | null;
}

/** SolanaNFTAssetModel */
export interface SolanaNft {
  address: string | null;
  mint: string | null;
  standard: string | null;
  name: string | null;
  symbol: string | null;
  description: string | null;
  imageOriginalUrl: string | null;
  externalUrl: string | null;
  metadataOriginalUrl: string | null;
  totalSupply: string | null;
  metaplex: { metadataUri: string | null; updateAuthority: string | null; sellerFeeBasisPoints: number | null; primarySaleHappened: number | null; isMutable: boolean | null; masterEdition: boolean | null } | null;
  collection: SolanaCollection | null;
  contract: { type: string | null; name: string | null; symbol: string | null } | null;
  /** held by the wallet (false: imported, view only); null when unknown */
  isOwned: boolean | null;
}

/** the SolanaNFTAssetModel constructor: texts sanitized, the image normalized */
export function solanaNft(f: Partial<SolanaNft>): SolanaNft {
  return {
    address: f.address ?? null,
    mint: f.mint ?? null,
    standard: f.standard ?? null,
    name: sanitizeNftText(f.name),
    symbol: sanitizeNftText(f.symbol),
    description: sanitizeNftText(f.description),
    imageOriginalUrl: normalizeIpfsUrl(f.imageOriginalUrl),
    externalUrl: f.externalUrl ?? null,
    metadataOriginalUrl: f.metadataOriginalUrl ?? null,
    totalSupply: f.totalSupply ?? null,
    metaplex: f.metaplex ?? null,
    collection: f.collection ?? null,
    contract: f.contract ?? null,
    isOwned: f.isOwned ?? null,
  };
}

/** SolanaNFTAssetModel.fromJson (Moralis) */
export function parseSolanaNft(json: any): SolanaNft {
  const mp = json?.metaplex;
  const c = json?.collection;
  const k = json?.contract;
  return solanaNft({
    address: str(json?.address),
    mint: str(json?.mint),
    standard: str(json?.standard),
    name: str(json?.name),
    symbol: str(json?.symbol),
    description: str(json?.description),
    imageOriginalUrl: str(json?.imageOriginalUrl),
    externalUrl: str(json?.externalUrl),
    metadataOriginalUrl: str(json?.metadataOriginalUrl),
    totalSupply: str(json?.totalSupply),
    metaplex: mp && typeof mp === 'object' ? { metadataUri: str(mp.metadataUri), updateAuthority: str(mp.updateAuthority), sellerFeeBasisPoints: int(mp.sellerFeeBasisPoints), primarySaleHappened: int(mp.primarySaleHappened), isMutable: typeof mp.isMutable === 'boolean' ? mp.isMutable : null, masterEdition: typeof mp.masterEdition === 'boolean' ? mp.masterEdition : null } : null,
    collection: c && typeof c === 'object' ? { collectionAddress: str(c.collectionAddress), name: sanitizeNftText(c.name), description: sanitizeNftText(c.description), imageOriginalUrl: normalizeIpfsUrl(str(c.imageOriginalUrl)), externalUrl: str(c.externalUrl), metaplexMint: str(c.metaplexMint), sellerFeeBasisPoints: int(c.sellerFeeBasisPoints) } : null,
    contract: k && typeof k === 'object' ? { type: str(k.type), name: sanitizeNftText(k.name), symbol: sanitizeNftText(k.symbol) } : null,
    isOwned: typeof json?.isOwned === 'boolean' ? json.isOwned : null,
  });
}

// ------------------------------------------------------------- saved NFTs --

/** ImportedNFT: a row of the wallet's saved NFTs (unique per chain and identifier) */
export interface SavedNft {
  chain: string;
  identifier: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  imageUrl: string | null;
  isOwned: boolean | null;
}

/** ImportedNFT.save (ConflictAlgorithm.replace): the old row goes, the new one is last */
export function saveRow(rows: SavedNft[], row: SavedNft): SavedNft[] {
  return [...rows.filter((r) => r.chain !== row.chain || r.identifier !== row.identifier), row];
}

/** ImportedNFT.updateMetadata: an existing row in place (nothing when there is none) */
export function updateRow(rows: SavedNft[], row: SavedNft): SavedNft[] {
  return rows.map((r) => (r.chain === row.chain && r.identifier === row.identifier ? row : r));
}

/** SavedNFTs._rowForSolana */
export function solanaRow(mint: string, a: SolanaNft): SavedNft {
  return { chain: SOLANA_CHAIN, identifier: mint, name: a.name, symbol: a.symbol, description: a.description, imageUrl: a.imageOriginalUrl, isOwned: a.isOwned };
}

/** SavedNFTs.addEvm's row (the image as normalized) */
export function evmRow(chain: string, a: NftAsset): SavedNft | null {
  const id = evmIdentifier(a);
  if (!id) return null;
  return { chain, identifier: id, name: a.name, symbol: a.symbol, description: a.normalizedMetadata?.description ?? null, imageUrl: a.normalizedMetadata ? nftImageUrl(a) : null, isOwned: null };
}

/** SavedNFTs.solanaNFTs: mint → asset */
export function savedSolana(rows: SavedNft[]): Map<string, SolanaNft> {
  const out = new Map<string, SolanaNft>();
  for (const r of rows) if (r.chain === SOLANA_CHAIN) out.set(r.identifier, solanaNft({ address: r.identifier, mint: r.identifier, name: r.name, symbol: r.symbol, description: r.description, imageOriginalUrl: r.imageUrl, isOwned: r.isOwned }));
  return out;
}

/** SavedNFTs.evmNFTs of a chain */
export function savedEvm(rows: SavedNft[], chain: string): NftAsset[] {
  return rows
    .filter((r) => r.chain === chain)
    .map((r) => {
      const parts = r.identifier.split(':');
      return { tokenAddress: parts[0], tokenId: parts.length > 1 ? parts.slice(1).join(':') : '', contractType: null, name: r.name, symbol: r.symbol, normalizedMetadata: { name: r.name, description: r.description, image: r.imageUrl } };
    });
}

/** _getEvmNFTAssets: the indexer's NFTs, then the saved ones it did not list */
export function mergeEvm(listed: NftAsset[], saved: NftAsset[]): NftAsset[] {
  const ids = new Set(listed.map(evmIdentifier));
  return [...listed, ...saved.filter((a) => !ids.has(evmIdentifier(a)))];
}

/**
 * _assetsToKeepFromPreviousRefresh: the same wallet's NFTs shown before that this refresh could not describe —
 * all of them when the indexer failed, else the ones whose details failed.
 */
export function keepFromPrevious(previous: SolanaNft[], described: SolanaNft[], failedMints: Set<string>, indexerFailed: boolean): SolanaNft[] {
  const mints = new Set(described.map((a) => a.mint));
  return previous.filter((a) => a.mint !== null && !mints.has(a.mint) && (indexerFailed || failedMints.has(a.mint)));
}

// ------------------------------------------------------- other sources ----

/** a Blockscout /api/v2/addresses/{address}/nft item as an NFTAssetModel (no key needed; spam left out) */
export function parseBlockscoutNft(item: any): NftAsset | null {
  const token = item?.token;
  const address = str(token?.address_hash) ?? str(token?.address);
  if (!address || typeof item?.id !== 'string') return null;
  if (typeof token?.reputation === 'string' && token.reputation !== 'ok') return null;
  const m = item.metadata && typeof item.metadata === 'object' ? item.metadata : null;
  return {
    tokenAddress: address.toLowerCase(),
    tokenId: item.id,
    contractType: str(item.token_type)?.replace('-', '') ?? null,
    name: sanitizeNftText(token?.name),
    symbol: sanitizeNftText(token?.symbol),
    normalizedMetadata: { name: sanitizeNftText(m?.name), description: sanitizeNftText(m?.description), image: str(m?.image) ?? str(m?.image_url) ?? str(item.image_url) },
  };
}

/** an ERC-1155 uri's "{id}": the token id as 64 lower-case hex digits */
export function erc1155Uri(uri: string, tokenId: bigint): string {
  return uri.replace(/\{id\}/g, tokenId.toString(16).padStart(64, '0'));
}

/** a data: URI's JSON (base64 or percent-encoded), else null */
export function dataUriJson(uri: string): unknown {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(uri.trim());
  if (!m || !/json/i.test(m[1] || 'application/json')) return null;
  try {
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
