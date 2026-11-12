// Lazy loaders for each wallet type's module (keeps the first load small).
import { registerCoin } from './module.ts';

registerCoin('bitcoin', () => import('./utxo/module.ts').then((m) => m.bitcoinModule));
registerCoin('litecoin', () => import('./utxo/module.ts').then((m) => m.litecoinModule));
registerCoin('bitcoinCash', () => import('./utxo/module.ts').then((m) => m.bitcoinCashModule));
registerCoin('dogecoin', () => import('./utxo/module.ts').then((m) => m.dogecoinModule));
registerCoin('monero', () => import('./monero/module.ts').then((m) => m.moneroModule));
registerCoin('ethereum', () => import('./evm/module.ts').then((m) => m.ethereumModule));
registerCoin('polygon', () => import('./evm/module.ts').then((m) => m.polygonModule));
registerCoin('base', () => import('./evm/module.ts').then((m) => m.baseModule));
registerCoin('arbitrum', () => import('./evm/module.ts').then((m) => m.arbitrumModule));
registerCoin('bsc', () => import('./evm/module.ts').then((m) => m.bscModule));
registerCoin('robinhood', () => import('./evm/module.ts').then((m) => m.robinhoodModule));
