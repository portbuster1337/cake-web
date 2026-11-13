// CoinModules for Bitcoin, Litecoin, Bitcoin Cash and Dogecoin
// (BitcoinWalletService / LitecoinWalletService / BitcoinCashWalletService / DogecoinWalletService).

import type { CoinModule, DerivationCandidate, NewWalletOptions, RestoreKeysOptions, RestoreSeedOptions } from '../module.ts';
import { newWalletId } from '../module.ts';
import type { WalletInfo, WalletSecrets } from '../../core/wallet.ts';
import type { WalletType } from '../types.ts';
import { generateBip39, validateBip39, bip39Seed } from '../seeds/bip39.ts';
import { generateElectrumMnemonic, isElectrumSeed, prefixMatches, electrumMnemonicToSeed } from '../seeds/electrum.ts';
import { KeyTree, convertAnyToXpub, defaultDerivationPath, type DerivationType } from './hd.ts';
import { NETWORKS, isValidAddress, pubkeyToAddress, type AddressType, type UtxoCoin } from './networks.ts';
import { UtxoWallet } from './wallet.ts';
import { HDKey } from '@scure/bip32';
import { makeIndexer } from './indexer.ts';
import { currentNode } from '../../core/nodes.ts';
import { formatFixed } from '../../core/amount.ts';

const COIN: Record<string, UtxoCoin> = { bitcoin: 'btc', litecoin: 'ltc', bitcoinCash: 'bch', dogecoin: 'doge' };

/** electrum_derivations.dart (electrum first, then the BIP39 entries) */
export const ELECTRUM_DERIVATIONS: { type: DerivationType; path: string; description: string; script: AddressType }[] = [
  { type: 'electrum', path: "m/0'", description: 'Electrum', script: 'p2wpkh' },
  { type: 'bip39', path: "m/44'/0'/0'", description: 'Standard BIP44', script: 'p2pkh' },
  { type: 'bip39', path: "m/49'/0'/0'", description: 'Standard BIP49 compatibility segwit', script: 'p2sh' },
  { type: 'bip39', path: "m/84'/0'/0'", description: 'Standard BIP84 native segwit', script: 'p2wpkh' },
  { type: 'bip39', path: "m/86'/0'/0'", description: 'Standard BIP86 Taproot', script: 'p2tr' },
  { type: 'bip39', path: "m/0'", description: 'Non-standard legacy', script: 'p2pkh' },
  { type: 'bip39', path: "m/0'", description: 'Non-standard compatibility segwit', script: 'p2sh' },
  { type: 'bip39', path: "m/0'", description: 'Non-standard native segwit', script: 'p2wpkh' },
  { type: 'bip39', path: "m/44'/0'/0'", description: 'Samourai Deposit', script: 'p2wpkh' },
  { type: 'bip39', path: "m/49'/0'/0'", description: 'Samourai Deposit', script: 'p2wpkh' },
  { type: 'bip39', path: "m/84'/0'/2147483644'", description: 'Samourai Bad Bank (toxic change)', script: 'p2wpkh' },
  { type: 'bip39', path: "m/84'/0'/2147483645'", description: 'Samourai Whirlpool Pre Mix', script: 'p2wpkh' },
  { type: 'bip39', path: "m/84'/0'/2147483646'", description: 'Samourai Whirlpool Post Mix', script: 'p2wpkh' },
  { type: 'bip39', path: "m/44'/0'/2147483647'", description: 'Samourai Ricochet legacy', script: 'p2pkh' },
  { type: 'bip39', path: "m/49'/0'/2147483647'", description: 'Samourai Ricochet compatibility segwit', script: 'p2sh' },
  { type: 'bip39', path: "m/84'/0'/2147483647'", description: 'Samourai Ricochet native segwit', script: 'p2wpkh' },
  { type: 'bip39', path: "m/84'/2'/0'", description: 'Default Litecoin', script: 'p2wpkh' },
];

function baseInfo(type: WalletType, name: string, isRecovery: boolean, derivationType: DerivationType, derivationPath: string): WalletInfo {
  return {
    id: newWalletId(),
    name,
    type,
    isRecovery,
    restoreHeight: 0,
    date: Date.now(),
    address: '',
    derivationInfo: { derivationType, derivationPath },
    seedType: derivationType,
  };
}

async function firstAddress(coin: UtxoCoin, secrets: WalletSecrets, derivationType: DerivationType, derivationPath: string): Promise<string> {
  const seed = secrets.mnemonic ? (derivationType === 'electrum' ? await electrumMnemonicToSeed(secrets.mnemonic, secrets.passphrase ?? '') : await bip39Seed(secrets.mnemonic, secrets.passphrase ?? '')) : undefined;
  const tree = new KeyTree({ coin, seed, xpub: secrets.engineData?.xpub as string | undefined, derivationType, derivationPath });
  const type: AddressType = coin === 'bch' || coin === 'doge' ? 'p2pkh' : 'p2wpkh';
  return tree.address({ type, account: 0, change: false, legacy: false }, 0);
}

function makeModule(type: WalletType): CoinModule {
  const coin = COIN[type];
  const hasElectrum = coin === 'btc' || coin === 'ltc';
  return {
    type,
    seedTypes: () => (hasElectrum ? [{ id: 'bip39', label: 'BIP39' }, { id: 'electrum', label: 'Electrum' }] : [{ id: 'bip39', label: 'BIP39' }]),
    seedWordCounts: () => (hasElectrum ? [12, 18, 24] : [12, 18, 24]),
    validateMnemonic: (m) => validateBip39(m) || (hasElectrum && isElectrumSeed(m)),
    validateAddress: (a) => isValidAddress(NETWORKS[coin], a),
    keysFields: () => (coin === 'btc' || coin === 'ltc' ? ['privateKey'] : []),

    async createWallet(o: NewWalletOptions) {
      const electrum = hasElectrum && o.seedType === 'electrum';
      // Electrum seeds ignore a group mnemonic (Cake quirk)
      const mnemonic = electrum ? generateElectrumMnemonic() : o.mnemonic ?? generateBip39(o.wordCount ?? 12);
      const derivationType: DerivationType = electrum ? 'electrum' : 'bip39';
      const derivationPath = defaultDerivationPath(coin, derivationType);
      const secrets: WalletSecrets = { mnemonic, passphrase: o.passphrase || undefined };
      const info = baseInfo(type, o.name, false, derivationType, derivationPath);
      info.address = await firstAddress(coin, secrets, derivationType, derivationPath);
      return { info, secrets };
    },

    async restoreFromSeed(o: RestoreSeedOptions) {
      const m = o.mnemonic.trim();
      const isEl = hasElectrum && prefixMatches(m, ['100', 'eb']).some(Boolean);
      if (!isEl && !validateBip39(m)) throw new Error('Incorrect recovery phrase');
      const derivationType: DerivationType = (o.derivationType as DerivationType) ?? (isEl ? 'electrum' : 'bip39');
      const derivationPath = o.derivationPath ?? defaultDerivationPath(coin, derivationType);
      const secrets: WalletSecrets = { mnemonic: m, passphrase: o.passphrase || undefined };
      const info = baseInfo(type, o.name, true, derivationType, derivationPath);
      info.address = await firstAddress(coin, secrets, derivationType, derivationPath);
      return { info, secrets };
    },

    async restoreFromKeys(o: RestoreKeysOptions) {
      if (coin !== 'btc' && coin !== 'ltc') throw new Error('Restoring from keys is not supported for this wallet');
      const raw = (o.privateKey ?? o.viewKey ?? '').trim();
      const xpub = convertAnyToXpub(raw);
      HDKey.fromExtendedKey(xpub, NETWORKS[coin].bip32); // validates
      const secrets: WalletSecrets = { engineData: { xpub } };
      const info = baseInfo(type, o.name, true, 'bip39', defaultDerivationPath(coin, 'bip39'));
      info.isWatchOnly = true;
      // WalletCreationVM: a restored wallet without a seed
      info.isNonSeedWallet = true;
      info.address = await firstAddress(coin, secrets, 'bip39', info.derivationInfo!.derivationPath!);
      return { info, secrets };
    },

    /** getDerivationsFromMnemonic: index-0 address of every candidate path, with its history size */
    async findDerivations(mnemonic: string, passphrase = ''): Promise<DerivationCandidate[]> {
      const m = mnemonic.trim();
      if (hasElectrum && prefixMatches(m, ['100'])[0]) return [{ derivationType: 'electrum', derivationPath: "m/0'", description: 'Electrum', address: await firstAddress(coin, { mnemonic: m, passphrase }, 'electrum', "m/0'") }];
      if (!hasElectrum) return [{ derivationType: 'bip39', derivationPath: defaultDerivationPath(coin, 'bip39'), description: 'BIP39', address: await firstAddress(coin, { mnemonic: m, passphrase }, 'bip39', defaultDerivationPath(coin, 'bip39')) }];
      const node = currentNode(type);
      const indexer = makeIndexer({ kind: node.kind as any, url: node.url, chain: node.chain, scope: `restore:${Date.now()}` });
      const bseed = await bip39Seed(m, passphrase);
      const eseed = await electrumMnemonicToSeed(m, passphrase);
      const out: DerivationCandidate[] = [];
      await Promise.all(
        ELECTRUM_DERIVATIONS.map(async (d) => {
          const seed = d.type === 'electrum' ? eseed : bseed;
          const depth = d.path.split('/').length - 1;
          const path = depth === 1 || depth === 3 ? `${d.path}/0` : d.path;
          const node0 = HDKey.fromMasterSeed(seed, NETWORKS[coin].bip32).derive(path).deriveChild(0);
          const address = pubkeyToAddress(NETWORKS[coin], node0.publicKey!, d.script);
          let txCount = 0;
          let balance = '0';
          try {
            const s = await indexer.address(address);
            txCount = s.txCount;
            balance = formatFixed(s.confirmed, 8);
          } catch { /* unreachable: treat as empty */ }
          out.push({ derivationType: d.type, derivationPath: d.path, scriptType: d.script, description: d.description, address, txCount, balance });
        }),
      );
      return out.sort((a, b) => (b.txCount ?? 0) - (a.txCount ?? 0));
    },

    async open(info: WalletInfo, secrets: WalletSecrets) {
      const w = new UtxoWallet(info, secrets);
      await w.init();
      return w;
    },
  };
}

export const bitcoinModule = makeModule('bitcoin');
export const litecoinModule = makeModule('litecoin');
export const bitcoinCashModule = makeModule('bitcoinCash');
export const dogecoinModule = makeModule('dogecoin');
