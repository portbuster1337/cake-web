// dEuro Savings (cw_evm/lib/deuro/deuro_savings.dart, lib/view_model/integrations/deuro_view_model.dart):
// the dEURO savings contract on Ethereum, read and called through the wallet's
// own node (over Tor).

import { decodeWord, encodeCall, SELECTOR, selectorOf } from '../coins/evm/eth.ts';
import type { PendingTransaction } from '../core/wallet.ts';

export const SAVINGS_V2 = '0x760233b90e45d186A9A98E911B115F7F4B90d3D9';
export const SAVINGS_GATEWAY_V1 = '0x073493d73258C4BEb6542e8dd3e1b2891C972303';
export const DEURO_TOKEN = '0xbA3f535bbCcCcA2A154b573Ca6c5A49BAAE0a3ea';
/** "Cake Wallet" */
export const FRONTEND_CODE = '0x00000000000000000000000000000000000000000043616b652057616c6c6574';
/** MIN_ACCRUED_INTEREST: collecting or reinvesting needs at least this much (wei) */
export const MIN_ACCRUED_INTEREST = 1_000_000_000_000n;
const MAX_UINT256 = (1n << 256n) - 1n;
/** "Withdraw at least a million to overflow and close the savings position" */
const V1_CLOSE_AMOUNT = 10n ** 24n;

const SEL = {
  savings: selectorOf('savings(address)'),
  accruedInterest: selectorOf('accruedInterest(address)'),
  currentRatePPM: selectorOf('currentRatePPM()'),
  save: selectorOf('save(uint192,bool)'),
  withdraw: selectorOf('withdraw(address,uint192)'),
  refreshBalance: selectorOf('refreshBalance(address)'),
  withdrawV1: selectorOf('withdraw(address,uint192,bytes32)'),
};

export const encodeSave = (amount: bigint) => encodeCall(SEL.save, [{ uint: amount }, { bool: true }]);
export const encodeWithdraw = (target: string, amount: bigint) => encodeCall(SEL.withdraw, [{ address: target }, { uint: amount }]);
export const encodeRefreshBalance = (owner: string) => encodeCall(SEL.refreshBalance, [{ address: owner }]);
export const encodeWithdrawV1 = (target: string) => encodeCall(SEL.withdrawV1, [{ address: target }, { uint: V1_CLOSE_AMOUNT }, { bytes32: FRONTEND_CODE }]);
/** an infinite approval, to save gas later */
export const encodeApproveSavings = () => encodeCall(SELECTOR.approve, [{ address: SAVINGS_V2 }, { uint: MAX_UINT256 }]);

/** what the savings page needs from an Ethereum wallet */
export interface DEuroWallet {
  address: string;
  callContract(to: string, data: Uint8Array): Promise<string>;
  createContractCall(to: string, data: Uint8Array, opts?: { priority?: string; amount?: bigint; amountDecimals?: number }): Promise<PendingTransaction>;
}

export interface SavingsData {
  approved: bigint;
  savings: bigint;
  accrued: bigint;
  savingsV1: bigint;
}

/** reloadSavingsUserData */
export async function savingsData(w: DEuroWallet): Promise<SavingsData> {
  const owner = { address: w.address };
  const [approved, savings, accrued, v1] = await Promise.all([
    w.callContract(DEURO_TOKEN, encodeCall(SELECTOR.allowance, [owner, { address: SAVINGS_V2 }])),
    w.callContract(SAVINGS_V2, encodeCall(SEL.savings, [owner])),
    w.callContract(SAVINGS_V2, encodeCall(SEL.accruedInterest, [owner])),
    w.callContract(SAVINGS_GATEWAY_V1, encodeCall(SEL.savings, [owner])),
  ]);
  // savings(address) → (uint192 saved, uint64 ticks)
  return { approved: decodeWord(approved), savings: decodeWord(savings, 0), accrued: decodeWord(accrued), savingsV1: decodeWord(v1, 0) };
}

/** reloadInterestRate: the PPM rate as Dart prints ppm / 10000 (a double: "10.0") */
export async function interestRate(w: DEuroWallet): Promise<string> {
  const ppm = Number(decodeWord(await w.callContract(SAVINGS_V2, encodeCall(SEL.currentRatePPM))));
  const v = ppm / 10000;
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/** InsufficientGasFeeException: "insufficient funds for gas" from the node */
function gasError(e: unknown): never {
  const m = (e as Error).message ?? String(e);
  if (/insufficient funds for gas|insufficient .* balance to cover the fees/i.test(m)) throw new Error('Insufficient ETH for gas fees. Please add ETH to your wallet to cover transaction fees.');
  throw e;
}

export const enableSavings = (w: DEuroWallet, priority?: string) => w.createContractCall(DEURO_TOKEN, encodeApproveSavings(), { priority, amount: MAX_UINT256, amountDecimals: 18 }).catch(gasError);
export const depositSavings = (w: DEuroWallet, amount: bigint, priority?: string) => w.createContractCall(SAVINGS_V2, encodeSave(amount), { priority, amount, amountDecimals: 18 }).catch(gasError);
export const withdrawSavings = (w: DEuroWallet, amount: bigint, priority?: string) => w.createContractCall(SAVINGS_V2, encodeWithdraw(w.address, amount), { priority, amount, amountDecimals: 18 }).catch(gasError);
export const reinvestInterest = (w: DEuroWallet, priority?: string) => w.createContractCall(SAVINGS_V2, encodeRefreshBalance(w.address), { priority, amount: 0n, amountDecimals: 18 }).catch(gasError);
export const withdrawSavingsV1 = (w: DEuroWallet, savedV1: bigint, priority?: string) => w.createContractCall(SAVINGS_GATEWAY_V1, encodeWithdrawV1(w.address), { priority, amount: savedV1, amountDecimals: 18 }).catch(gasError);
