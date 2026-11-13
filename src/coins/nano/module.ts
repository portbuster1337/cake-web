// CoinModule for Nano (cw_nano/lib/nano_wallet_service.dart, lib/nano/cw_nano.dart):
// a BIP39 mnemonic (12/24 words, HD key m/44'/165'/0') or a Nano standard
// seed (24 words = the 32-byte seed); restore from a 64-hex standard seed or a
// 128-hex BIP39 seed; no passphrase. The derivation of a 24-word phrase or a
// standard hex seed is found from the accounts' histories, like Cake does.

import type { CoinModule, DerivationCandidate, NewWalletOptions, RestoreKeysOptions, RestoreSeedOptions } from '../module.ts';
import { newWalletId } from '../module.ts';
import type { WalletInfo, WalletSecrets } from '../../core/wallet.ts';
import { currentNode, nodesFor } from '../../core/nodes.ts';
import { NanoRpc } from './rpc.ts';
import { generateBip39, validateBip39 } from '../seeds/bip39.ts';
import { generateStandardSeed, isValidNanoAddress, nanoKeys, standardSeedToMnemonic, type NanoDerivation } from './nano.ts';
import { NanoWallet, nanoUsable } from './wallet.ts';

const MNEMONIC_ERROR = 'Nano mnemonic has incorrect format. Mnemonic should contain 12 or 24 words separated by space.';

function info(name: string, isRecovery: boolean, address: string, derivation: NanoDerivation, isNonSeed: boolean): WalletInfo {
  return {
    id: newWalletId(),
    name,
    type: 'nano',
    isRecovery,
    restoreHeight: 0,
    date: Date.now(),
    address,
    derivationInfo: { derivationType: derivation },
    seedType: derivation,
    isNonSeedWallet: isNonSeed,
  };
}

async function build(name: string, isRecovery: boolean, secrets: WalletSecrets, derivation: NanoDerivation): Promise<{ info: WalletInfo; secrets: WalletSecrets }> {
  const k = await nanoKeys(secrets, derivation, 0);
  return { info: info(name, isRecovery, k.address, derivation, isRecovery && !secrets.mnemonic), secrets };
}

/**
 * NanoUtil.getInfoFromSeedOrMnemonic's account_info: confirmation height and balance, null when the account is
 * unopened. Cake also treats an unreachable node as "unopened", which picks a derivation blindly; here the other
 * built-in nodes are asked first (a public node may refuse a Tor exit for a while).
 */
async function accountInfo(rpc: NanoRpc, address: string): Promise<{ height: number; balance: string } | null> {
  const first = currentNode('nano');
  const urls = [first, ...nodesFor('nano').filter((n) => n.builtin && n.id !== first.id && !n.url.includes('nownodes'))].map((n) => n.url.replace(/\/+$/, ''));
  for (const url of urls.slice(0, 4)) {
    try {
      const r = await rpc.call<any>(url, { action: 'account_info', representative: 'true', account: address }, 'derivation check');
      if (typeof r?.frontier === 'string') return { height: Number(r.confirmation_height ?? 0), balance: String(r.balance ?? '0') };
      if (/not found/i.test(String(r?.error ?? ''))) return null;
    } catch { /* next node */ }
  }
  return null;
}

export const nanoModule: CoinModule = {
  type: 'nano',
  /** NanoSeedType.all */
  seedTypes: () => [
    { id: 'nano', label: 'Nano' },
    { id: 'bip39', label: 'BIP39' },
  ],
  seedWordCounts: () => [12, 24],
  validateMnemonic: (m) => validateBip39(m.trim()),
  validateAddress: (a) => isValidNanoAddress(a),
  keysFields: () => ['hexSeed'],

  async createWallet(o: NewWalletOptions) {
    const derivation: NanoDerivation = o.seedType === 'nano' && !o.mnemonic ? 'nano' : 'bip39';
    const mnemonic = o.mnemonic ?? (derivation === 'nano' ? standardSeedToMnemonic(generateStandardSeed()) : generateBip39(o.wordCount === 24 ? 24 : 12));
    return build(o.name, false, { mnemonic }, derivation);
  },

  /** NanoWalletService.restoreFromSeed: BIP39 words (checksum checked), or a 64/128-hex seed */
  async restoreFromSeed(o: RestoreSeedOptions) {
    const m = o.mnemonic.trim().split(/\s+/).join(' ');
    const derivation: NanoDerivation = o.derivationType === 'bip39' ? 'bip39' : 'nano';
    if (m.includes(' ')) {
      if (!validateBip39(m)) throw new Error(MNEMONIC_ERROR);
      return build(o.name, true, { mnemonic: m }, derivation);
    }
    if (!/^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{128}$/.test(m)) throw new Error('invalid seed length');
    return build(o.name, true, { hexSeed: m }, derivation);
  },

  /** NanoWalletService.restoreFromKeys: a 64-hex seed becomes its 24-word mnemonic; a 128-hex one stays a hex seed */
  async restoreFromKeys(o: RestoreKeysOptions) {
    const key = (o.hexSeed || o.privateKey || '').trim();
    if (key.includes(' ')) throw new Error('Invalid key!');
    if (key.length !== 64 && key.length !== 128) throw new Error('Invalid key length!');
    if (!/^[0-9a-fA-F]+$/.test(key)) throw new Error(key.length === 64 ? "Wasn't a valid nano style seed!" : 'Invalid key!');
    const derivation: NanoDerivation = o.derivationType === 'bip39' ? 'bip39' : 'nano';
    if (key.length === 64) return build(o.name, true, { mnemonic: standardSeedToMnemonic(key) }, derivation);
    return build(o.name, true, { hexSeed: key }, derivation);
  },

  /**
   * NanoUtil.getDerivationsFromMnemonic / compareDerivationMethods: 12 words or a 128-hex seed are BIP39;
   * otherwise the account of each derivation is looked up, and only those with history are offered.
   */
  async findDerivations(mnemonic: string, _passphrase?: string, seedKey?: string): Promise<DerivationCandidate[]> {
    let m = mnemonic.trim();
    const key = seedKey?.trim();
    if (!key && m.split(' ').length === 12) return [{ derivationType: 'bip39', description: '', address: '' }];
    if (key?.length === 128) return [{ derivationType: 'bip39', description: '', address: '' }];
    if (key?.length === 64) {
      try {
        m = standardSeedToMnemonic(key);
      } catch { /* not hex */ }
    }
    if (!m.includes(' ')) return [];
    const addr = async (d: NanoDerivation) => {
      try {
        return (await nanoKeys({ mnemonic: m }, d)).address;
      } catch {
        return null;
      }
    };
    const [bip39Address, standardAddress] = await Promise.all([addr('bip39'), m.split(' ').length === 24 ? addr('nano') : Promise.resolve(null)]);
    const rpc = new NanoRpc(`restore:${Date.now()}`);
    const [bip39Info, standardInfo] = await Promise.all([bip39Address ? accountInfo(rpc, bip39Address) : null, standardAddress ? accountInfo(rpc, standardAddress) : null]);
    if (!bip39Info && standardInfo) return [{ derivationType: 'nano', description: '', address: standardAddress! }];
    if (!standardInfo && bip39Info) return [{ derivationType: 'bip39', description: '', address: bip39Address! }];
    const list: DerivationCandidate[] = [];
    if (standardInfo && standardInfo.height > 0) list.push({ derivationType: 'nano', description: '', address: standardAddress!, balance: nanoUsable(standardInfo.balance), txCount: standardInfo.height });
    if (bip39Info && bip39Info.height > 0) list.push({ derivationType: 'bip39', description: '', address: bip39Address!, balance: nanoUsable(bip39Info.balance), txCount: bip39Info.height });
    return list;
  },

  async open(i: WalletInfo, s: WalletSecrets) {
    const w = new NanoWallet(i, s);
    await w.init();
    return w;
  },
};
