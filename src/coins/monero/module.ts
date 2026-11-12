// Monero CoinModule (cw_monero/lib/monero_wallet_service.dart): Polyseed
// (default), legacy 25-word, BIP39 ("Monero from BIP39", wallet groups),
// restore from seed/keys, with Cake's restore-height rules.

import { HDKey } from '@scure/bip32';
import type { CoinModule, NewWalletOptions, RestoreKeysOptions, RestoreSeedOptions } from '../module.ts';
import { newWalletId } from '../module.ts';
import type { WalletInfo, WalletSecrets } from '../../core/wallet.ts';
import { router } from '../../net/http.ts';
import { WalletWorker } from './engine.ts';
import { MoneroApi } from './api.ts';
import { MoneroWallet, type MoneroEngineData } from './wallet.ts';
import { Polyseed, PolyseedCoin, scReduce32, toHex, bytesToLE, leToBytes, L } from './polyseed.ts';
import { estimateMoneroHeight } from '../heights.ts';
import { bip39Seed, generateBip39, validateBip39 } from '../seeds/bip39.ts';

function randomPassword(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** cw_monero/lib/bip39_seed.dart: BIP32(m/44'/128'/0'/0/0) private key, little-endian, mod l */
export async function bip39ToMoneroSpendKey(mnemonic: string, passphrase = ''): Promise<string> {
  const seed = await bip39Seed(mnemonic, passphrase);
  const k = HDKey.fromMasterSeed(seed).derive("m/44'/128'/0'/0/0").privateKey!;
  return toHex(leToBytes(bytesToLE(k) % L));
}

async function withWorker<T>(fn: (w: WalletWorker) => Promise<T>): Promise<T> {
  const w = new WalletWorker(router(), './monero.worker.host.js');
  try {
    return await fn(w);
  } finally {
    w.terminate();
  }
}

async function finish(api: MoneroApi, password: string, info: Omit<WalletInfo, 'address'> & { address?: string }, secrets: WalletSecrets): Promise<{ info: WalletInfo; secrets: WalletSecrets }> {
  const address = await api.getPrimaryAddress();
  const { keys, cache } = await api.getData();
  await api.close();
  const engineData: MoneroEngineData = { keys, cache, password };
  return { info: { ...info, address } as WalletInfo, secrets: { ...secrets, engineData: engineData as any } };
}

function baseInfo(name: string, isRecovery: boolean, seedType: string, height: number): Omit<WalletInfo, 'address'> {
  return { id: newWalletId(), name, type: 'monero', isRecovery, restoreHeight: height, date: Date.now(), seedType, derivationInfo: seedType === 'bip39' ? { derivationType: 'bip39', derivationPath: "m/44'/128'/0'/0/0" } : undefined };
}

async function fromSpendKey(w: WalletWorker, spendHex: string, password: string, height: number): Promise<MoneroApi> {
  return MoneroApi.create(w, { password, privateSpendKey: spendHex, restoreHeight: height });
}

export const moneroModule: CoinModule = {
  type: 'monero',
  seedTypes: () => [
    { id: 'polyseed', label: 'Polyseed (16 words)' },
    { id: 'legacy', label: 'Legacy (25 words)' },
    { id: 'bip39', label: 'BIP39 (12 words)' },
  ],
  seedWordCounts: () => [25, 16, 12, 24],
  validateMnemonic: (m) => {
    const n = m.trim().split(/\s+/).length;
    return n === 25 || n === 16 || n === 14 || validateBip39(m.trim());
  },
  validateAddress: (a) => /^[48][0-9a-zA-Z]{94}$|^[0-9a-zA-Z]{106}$/.test(a.trim()),
  keysFields: () => ['address', 'viewKey', 'spendKey', 'height'],

  async createWallet(o: NewWalletOptions) {
    const password = randomPassword();
    const type = o.mnemonic ? 'bip39' : o.seedType ?? 'polyseed';
    return withWorker(async (w) => {
      if (type === 'bip39') {
        const mnemonic = o.mnemonic ?? generateBip39(12);
        const height = estimateMoneroHeight(new Date());
        const api = await fromSpendKey(w, await bip39ToMoneroSpendKey(mnemonic, o.passphrase ?? ''), password, height);
        return finish(api, password, baseInfo(o.name, false, 'bip39', height), { mnemonic, passphrase: o.passphrase || undefined });
      }
      if (type === 'polyseed') {
        const ps = Polyseed.create();
        const spend = toHex(scReduce32(await ps.generateKey(PolyseedCoin.MONERO)));
        const height = estimateMoneroHeight(new Date(Date.now() - 2 * 86_400_000));
        const shown = ps.clone();
        if (o.passphrase) await shown.crypt(o.passphrase);
        const api = await fromSpendKey(w, spend, password, height);
        return finish(api, password, baseInfo(o.name, false, 'polyseed', height), { mnemonic: shown.encode(), passphrase: o.passphrase || undefined, engineData: { polyseed: ps.encode() } as any });
      }
      // legacy 25 words (passphrase = wallet2 seed offset)
      const height = estimateMoneroHeight(new Date());
      let api = await MoneroApi.create(w, { password, language: o.language ?? 'English' });
      let words = await api.getSeed();
      if (o.passphrase) {
        await api.close();
        api = await MoneroApi.create(w, { password, seed: words, seedOffset: o.passphrase, restoreHeight: height });
      } else await api.setRestoreHeight(height);
      return finish(api, password, baseInfo(o.name, false, 'legacy', height), { mnemonic: words, passphrase: o.passphrase || undefined });
    });
  },

  async restoreFromSeed(o: RestoreSeedOptions) {
    const password = randomPassword();
    const m = o.mnemonic.trim().split(/\s+/).join(' ');
    const n = m.split(' ').length;
    return withWorker(async (w) => {
      if (n === 16) {
        const lang = await Polyseed.detectLanguage(m);
        const ps = Polyseed.decode(m, lang, PolyseedCoin.MONERO);
        const wasEncrypted = ps.isEncrypted;
        if (wasEncrypted) {
          if (!o.passphrase) throw new Error('This polyseed is encrypted: enter its passphrase');
          await ps.crypt(o.passphrase);
        }
        const spend = toHex(scReduce32(await ps.generateKey(PolyseedCoin.MONERO)));
        const height = estimateMoneroHeight(new Date(ps.birthday * 1000));
        if (!wasEncrypted && o.passphrase) {
          // Feather-compatible offset path: key = polyseed_keygen(seed) - H(passphrase)
          const tmp = await fromSpendKey(w, spend, password, height);
          const legacy = await tmp.getSeed();
          await tmp.close();
          const api = await MoneroApi.create(w, { password, seed: legacy, seedOffset: o.passphrase, restoreHeight: height });
          return finish(api, password, baseInfo(o.name, true, 'polyseed', height), { mnemonic: m, passphrase: o.passphrase });
        }
        const api = await fromSpendKey(w, spend, password, height);
        return finish(api, password, baseInfo(o.name, true, 'polyseed', height), { mnemonic: m, passphrase: o.passphrase || undefined });
      }
      if ((n === 12 || n === 24 || n === 18) && validateBip39(m)) {
        const height = o.height ?? 0;
        const api = await fromSpendKey(w, await bip39ToMoneroSpendKey(m, o.passphrase ?? ''), password, height);
        return finish(api, password, baseInfo(o.name, true, 'bip39', height), { mnemonic: m, passphrase: o.passphrase || undefined });
      }
      if (n === 25) {
        const height = o.height ?? 0;
        let api: MoneroApi;
        try {
          api = await MoneroApi.create(w, { password, seed: m, seedOffset: o.passphrase ?? '', restoreHeight: height });
        } catch (e) {
          if (/word list|invalid|checksum/i.test((e as Error).message)) throw new Error('Seed verification failed, please make sure you entered the correct seed with the correct words order');
          throw e;
        }
        return finish(api, password, baseInfo(o.name, true, 'legacy', height), { mnemonic: m, passphrase: o.passphrase || undefined });
      }
      throw new Error('Incorrect recovery phrase');
    });
  },

  async restoreFromKeys(o: RestoreKeysOptions) {
    const password = randomPassword();
    const height = o.height ?? 0;
    return withWorker(async (w) => {
      let api: MoneroApi;
      if (o.spendKey) {
        api = await fromSpendKey(w, o.spendKey.trim(), password, height);
        const derivedView = await api.getPrivateViewKey();
        if (o.viewKey && o.viewKey.trim() !== derivedView) {
          await api.close();
          api = await MoneroApi.create(w, { password, primaryAddress: o.address?.trim(), privateViewKey: o.viewKey.trim(), privateSpendKey: o.spendKey.trim(), restoreHeight: height });
        }
      } else {
        api = await MoneroApi.create(w, { password, primaryAddress: o.address?.trim(), privateViewKey: o.viewKey?.trim(), restoreHeight: height });
      }
      const info = baseInfo(o.name, true, 'keys', height);
      const res = await finish(api, password, info, {});
      if (!o.spendKey) res.info.isWatchOnly = true;
      res.info.isNonSeedWallet = true;
      return res;
    });
  },

  async open(info: WalletInfo, secrets: WalletSecrets) {
    const w = new MoneroWallet(info, secrets);
    await w.init();
    return w;
  },
};
