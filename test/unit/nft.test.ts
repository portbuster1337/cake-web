import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipfsGatewayUrls, ipfsPath, normalizeIpfsUrl, IPFS_GATEWAYS } from '../../src/net/ipfs.ts';
import { sniffImage } from '../../src/net/remote.ts';
import { closeAccount, tokenAccountAmount } from '../../src/coins/solana/sol.ts';
import {
  dataUriJson, erc1155Uri, evmIdentifier, evmRow, isNftChain, keepFromPrevious, mergeEvm, nftChainName, nftImageUrl, parseBlockscoutNft, parseNftAsset, parseSolanaNft,
  sanitizeNftText, saveRow, savedEvm, savedSolana, solanaNft, solanaRow, updateRow, type SavedNft,
} from '../../src/nft/models.ts';

test('sanitizeNFTText: control and bidi characters become spaces, trimmed, at most 512 characters', () => {
  assert.equal(sanitizeNftText('  Ape\u202E#1\n'), 'Ape #1');
  assert.equal(sanitizeNftText('a\u200Bb\u0007c'), 'a b c');
  assert.equal(sanitizeNftText('tag\u{E0041}x'), 'tag x');
  assert.equal(sanitizeNftText(null), null);
  assert.equal(sanitizeNftText(42), null);
  const long = '😀'.repeat(600);
  const s = sanitizeNftText(long)!;
  // code points, as Dart's runes: 512 emoji and the ellipsis
  assert.equal([...s].length, 513);
  assert.ok(s.endsWith('\u2026'));
  assert.equal(sanitizeNftText('x'.repeat(512)), 'x'.repeat(512));
});

test('tryNormalizeIpfsUrl: ipfs:// through the gateway, https kept, anything else dropped', () => {
  assert.equal(normalizeIpfsUrl('ipfs://QmAbc/1.json'), 'https://ipfs.io/ipfs/QmAbc/1.json');
  assert.equal(normalizeIpfsUrl('IPFS://ipfs/QmAbc'), 'https://ipfs.io/ipfs/QmAbc');
  assert.equal(normalizeIpfsUrl('ipfs://'), null);
  assert.equal(normalizeIpfsUrl('https://x.test/a.png'), 'https://x.test/a.png');
  assert.equal(normalizeIpfsUrl('http://x.test/a.png'), null);
  assert.equal(normalizeIpfsUrl('data:image/png;base64,AAAA'), null);
  assert.equal(normalizeIpfsUrl(undefined), null);
});

test('IPFS links are fetched from the gateways that still answer over Tor', () => {
  assert.equal(ipfsPath('ipfs://QmAbc/1.json'), 'QmAbc/1.json');
  assert.equal(ipfsPath('https://ipfs.io/ipfs/QmAbc/1.json?x=1'), 'QmAbc/1.json?x=1');
  assert.equal(ipfsPath('https://bafybeigdyr.ipfs.dweb.link/wiki/'), 'bafybeigdyr/wiki/');
  assert.equal(ipfsPath('https://bafybeigdyr.ipfs.dweb.link/'), 'bafybeigdyr');
  assert.equal(ipfsPath('https://ipfs.moralis.io:2053/ipfs/QmAbc'), 'QmAbc');
  assert.equal(ipfsPath('https://example.com/ipfs/QmAbc'), null);
  assert.equal(ipfsPath('http://ipfs.io/ipfs/QmAbc'), null);
  assert.deepEqual(ipfsGatewayUrls('https://ipfs.io/ipfs/QmAbc'), IPFS_GATEWAYS.map((g) => `${g}QmAbc`));
  assert.deepEqual(ipfsGatewayUrls('https://arweave.net/abc'), ['https://arweave.net/abc']);
});

test('images: the type from the header, else from the first bytes', () => {
  const b = (...x: number[]) => Uint8Array.from(x);
  const ascii = (s: string) => new TextEncoder().encode(s);
  assert.equal(sniffImage(b(0), 'image/png; charset=binary'), 'image/png');
  assert.equal(sniffImage(b(0x89, 0x50, 0x4e, 0x47), 'application/octet-stream'), 'image/png');
  assert.equal(sniffImage(b(0xff, 0xd8, 0xff), ''), 'image/jpeg');
  assert.equal(sniffImage(ascii('GIF89a'), ''), 'image/gif');
  assert.equal(sniffImage(ascii('RIFF\0\0\0\0WEBPVP8 '), ''), 'image/webp');
  assert.equal(sniffImage(ascii('\0\0\0\x1cftypavif'), ''), 'image/avif');
  assert.equal(sniffImage(ascii('  <svg xmlns="http://www.w3.org/2000/svg"/>'), 'text/plain'), 'image/svg+xml');
  assert.equal(sniffImage(ascii('<html>'), 'text/html'), null);
});

test('chains: NFTs on Ethereum, Base, Polygon, Arbitrum, BNB Smart Chain and Solana; Moralis chain names', () => {
  for (const id of [1, 8453, 137, 42161, 56]) assert.ok(isNftChain('ethereum', id));
  assert.ok(!isNftChain('robinhood', 4663));
  assert.ok(isNftChain('solana'));
  assert.ok(!isNftChain('bitcoin'));
  assert.equal(nftChainName('solana'), 'mainnet');
  assert.equal(nftChainName('polygon', 137), 'polygon');
  assert.equal(nftChainName('bsc', 56), 'bsc');
  assert.equal(nftChainName('ethereum', 1), 'eth');
});

test('EVM NFTs: Moralis fields, the identifier, saved rows, the merged list', () => {
  const a = parseNftAsset({ token_address: '0xabc', token_id: '7', contract_type: 'ERC721', name: 'Apes\u202E', symbol: 'APE', normalized_metadata: { name: 'Ape #7', description: 'An ape', image: 'ipfs://QmImg' } });
  assert.equal(a.name, 'Apes');
  assert.equal(evmIdentifier(a), '0xabc:7');
  assert.equal(nftImageUrl(a), 'https://ipfs.io/ipfs/QmImg');
  const row = evmRow('eth', a)!;
  assert.deepEqual(row, { chain: 'eth', identifier: '0xabc:7', name: 'Apes', symbol: 'APE', description: 'An ape', imageUrl: 'https://ipfs.io/ipfs/QmImg', isOwned: null });
  assert.equal(evmRow('eth', { ...a, tokenAddress: null }), null);
  const saved = savedEvm([row, { ...row, chain: 'base' }], 'eth');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].tokenId, '7');
  assert.equal(saved[0].normalizedMetadata?.name, 'Apes');
  assert.equal(savedEvm([{ ...row, identifier: '0xdef:a:b' }], 'eth')[0].tokenId, 'a:b');
  const b = parseNftAsset({ token_address: '0xdef', token_id: '1' });
  // the indexer's NFTs first, then the saved ones it did not list
  assert.deepEqual(mergeEvm([a], [saved[0], savedEvm([{ ...row, identifier: '0xdef:1' }], 'eth')[0]]).map(evmIdentifier), ['0xabc:7', '0xdef:1']);
  assert.deepEqual(mergeEvm([b], saved).map(evmIdentifier), ['0xdef:1', '0xabc:7']);
});

test('Solana NFTs: Moralis fields sanitized and normalized, saved rows, refresh bookkeeping', () => {
  const n = parseSolanaNft({ mint: 'M1', name: 'Mad\u202ELad', symbol: 'MAD', description: 'x', imageOriginalUrl: 'ipfs://QmA', contract: { type: 'NFT', name: 'Mad Lads', symbol: 'MAD' }, collection: { collectionAddress: 'C1', name: 'Coll', imageOriginalUrl: 'http://bad' }, metaplex: { metadataUri: 'https://m', isMutable: true, sellerFeeBasisPoints: 500 } });
  assert.equal(n.name, 'Mad Lad');
  assert.equal(n.imageOriginalUrl, 'https://ipfs.io/ipfs/QmA');
  assert.equal(n.collection?.imageOriginalUrl, null);
  assert.equal(n.metaplex?.sellerFeeBasisPoints, 500);
  assert.equal(n.isOwned, null);
  const row = solanaRow('M1', { ...n, isOwned: false });
  assert.equal(row.chain, 'solana');
  const back = savedSolana([row]).get('M1')!;
  assert.equal(back.mint, 'M1');
  assert.equal(back.isOwned, false);
  assert.equal(back.imageOriginalUrl, 'https://ipfs.io/ipfs/QmA');
  // save replaces and moves to the end; update keeps the place and needs a row
  const r1: SavedNft = { ...row, identifier: 'A' };
  const r2: SavedNft = { ...row, identifier: 'B' };
  assert.deepEqual(saveRow([r1, r2], { ...r1, name: 'new' }).map((r) => [r.identifier, r.name]), [['B', row.name], ['A', 'new']]);
  assert.deepEqual(updateRow([r1, r2], { ...r1, name: 'upd' }).map((r) => r.name), ['upd', row.name]);
  assert.deepEqual(updateRow([r2], { ...r1, name: 'upd' }).map((r) => r.identifier), ['B']);
  // the previous refresh's NFTs that this one could not describe
  const prev = [solanaNft({ mint: 'A' }), solanaNft({ mint: 'B' }), solanaNft({ mint: 'C' })];
  const described = [solanaNft({ mint: 'A' })];
  assert.deepEqual(keepFromPrevious(prev, described, new Set(['C']), false).map((a) => a.mint), ['C']);
  assert.deepEqual(keepFromPrevious(prev, described, new Set(), true).map((a) => a.mint), ['B', 'C']);
});

test('Blockscout NFT items as NFTAssetModel; spam left out', () => {
  const a = parseBlockscoutNft({ id: '42', token_type: 'ERC-1155', image_url: 'https://img', metadata: { name: 'Thing', description: 'd' }, token: { address_hash: '0xAbC', name: 'Things', symbol: 'TH', reputation: 'ok' } })!;
  assert.deepEqual(a, { tokenAddress: '0xabc', tokenId: '42', contractType: 'ERC1155', name: 'Things', symbol: 'TH', normalizedMetadata: { name: 'Thing', description: 'd', image: 'https://img' } });
  assert.equal(parseBlockscoutNft({ id: '1', token: { address_hash: '0x1', reputation: 'scam' } }), null);
  assert.equal(parseBlockscoutNft({ id: '1', token: {} }), null);
  assert.equal(parseBlockscoutNft({ id: '1', metadata: { image: 'ipfs://Q' }, token: { address_hash: '0x1', reputation: null } })?.normalizedMetadata?.image, 'ipfs://Q');
});

test('token metadata URIs: ERC-1155 {id}, inline data: JSON', () => {
  assert.equal(erc1155Uri('https://x/{id}.json', 255n), `https://x/${'0'.repeat(62)}ff.json`);
  const j = { name: 'On-chain', image: 'data:image/svg+xml;base64,PHN2Zz4=' };
  assert.deepEqual(dataUriJson(`data:application/json;base64,${btoa(JSON.stringify(j))}`), j);
  assert.deepEqual(dataUriJson(`data:application/json,${encodeURIComponent(JSON.stringify(j))}`), j);
  assert.deepEqual(dataUriJson(`data:application/json;utf8,${encodeURIComponent('{"a":1}')}`), { a: 1 });
  assert.equal(dataUriJson('data:image/png;base64,AAAA'), null);
  assert.equal(dataUriJson('https://x/1.json'), null);
  assert.equal(dataUriJson('data:application/json;base64,!!!'), null);
});

test('SPL token accounts: the amount field, CloseAccount', () => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, 1n, true);
  assert.equal(tokenAccountAmount(data), 1n);
  assert.equal(tokenAccountAmount(new Uint8Array(10)), null);
  const ix = closeAccount({ tokenProgram: 'P', account: 'A', destination: 'D', owner: 'O' });
  assert.deepEqual([...ix.data], [9]);
  assert.deepEqual(ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), [['A', false, true], ['D', false, true], ['O', true, false]]);
});
