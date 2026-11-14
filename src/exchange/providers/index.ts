// The swap providers, in Cake's order (exchange_view_model.dart:302-316).

import type { ExchangeProvider } from '../types.ts';
import { changeNow } from './changenow.ts';
import { chainflip } from './chainflip.ts';
import { swapTrade } from './swaptrade.ts';
import { whyNot } from './whynot.ts';
import { xoSwap } from './xoswap.ts';
import { jupiter } from './jupiter.ts';
import { nearIntents } from './near.ts';
import { trocador } from './trocador.ts';
import { swapsXyz } from './swapsxyz.ts';

export const ALL_PROVIDERS: ExchangeProvider[] = [changeNow, chainflip, swapTrade, whyNot, xoSwap, swapsXyz, jupiter, nearIntents, trocador];

/** the provider of a stored trade (status updates, details) */
export function providerForRaw(raw: number): ExchangeProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.description.raw === raw);
}

export { changeNow, chainflip, swapTrade, whyNot, xoSwap, swapsXyz, jupiter, nearIntents, trocador };
