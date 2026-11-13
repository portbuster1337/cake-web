// The buy and sell providers (lib/entities/provider_types.dart): buy — Robinhood,
// DFX, Onramper, MoonPay, Kryptonim; sell — the same without Robinhood. Robinhood
// Connect needs Cake's application id and a connect id from Cake's exchange
// helper, which this build cannot have, so it is left out.

import type { WalletBase } from '../../core/wallet.ts';
import type { BuyMode, BuyProvider } from '../types.ts';
import { createDfx } from './dfx.ts';
import { createOnramper } from './onramper.ts';
import { createMoonPay } from './moonpay.ts';
import { createKryptonim } from './kryptonim.ts';

export function buyProviders(w: WalletBase, _mode: BuyMode): BuyProvider[] {
  return [createDfx(w), createOnramper(), createMoonPay(), createKryptonim()];
}
