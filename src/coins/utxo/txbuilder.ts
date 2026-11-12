// Building and signing UTXO transactions (BTC, LTC, DOGE via @scure/btc-signer;
// BCH with its own SIGHASH_FORKID signer, see bch.ts), and Cake Wallet's size
// estimates (cw_bitcoin electrum_wallet.dart estimatedInputSize/OutputSize).

import { Transaction, p2wpkh, p2sh, OutScript } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { addressToScript, signerNet, type AddressType, type UtxoNetwork } from './networks.ts';
import { buildBchTransaction } from './bch.ts';

export interface SpendInput {
  txid: string;
  vout: number;
  value: bigint;
  address: string;
  type: AddressType;
  pubkey: Uint8Array;
  privkey: Uint8Array;
  confirmations: number;
  /** full previous transaction, needed for legacy (non-segwit) BTC inputs */
  prevTxHex?: string;
}

export interface SpendOutput {
  address: string;
  value: bigint;
  isChange?: boolean;
}

export interface BuiltTx {
  hex: string;
  txid: string;
  vsize: number;
  fee: bigint;
  inputs: SpendInput[];
  outputs: SpendOutput[];
}

/** vbytes per input type (ElectrumWallet.estimatedInputSize) */
export function inputVbytes(type: AddressType): number {
  switch (type) {
    case 'p2pkh':
      return 148;
    case 'p2sh':
      return 91;
    case 'p2tr':
    case 'silent_payments':
      return 58;
    case 'p2wsh':
      return 105;
    default:
      return 68;
  }
}

/** vbytes per output type (ElectrumWallet.estimatedOutputSize) */
export function outputVbytes(type: AddressType): number {
  switch (type) {
    case 'p2pkh':
      return 34;
    case 'p2sh':
      return 32;
    case 'p2tr':
    case 'p2wsh':
    case 'silent_payments':
      return 43;
    default:
      return 31;
  }
}

/** ElectrumWallet.estimatedTransactionSize(inputs, outputs) = 68·in + 34·out + 10 */
export function genericTxSize(inputs: number, outputs: number): number {
  return inputs * 68 + outputs * 34 + 10;
}

export function outputTypeOf(net: UtxoNetwork, address: string): AddressType {
  try {
    const s = OutScript.decode(addressToScript(net, address));
    switch (s.type) {
      case 'pkh':
        return 'p2pkh';
      case 'sh':
        return 'p2sh';
      case 'wpkh':
        return 'p2wpkh';
      case 'wsh':
        return 'p2wsh';
      case 'tr':
        return 'p2tr';
    }
  } catch { /* fall through */ }
  return 'p2wpkh';
}

/** Size estimate of a transaction with these inputs/outputs (vbytes, rounded up). */
export function estimateVsize(net: UtxoNetwork, inputTypes: AddressType[], outputs: (AddressType | string)[]): number {
  const outTypes = outputs.map((o) => (o.length > 12 ? outputTypeOf(net, o) : (o as AddressType)));
  const segwit = inputTypes.some((t) => t !== 'p2pkh');
  const overhead = 4 + 4 + varIntSize(inputTypes.length) + varIntSize(outTypes.length) + (segwit ? 0.5 : 0);
  const ins = inputTypes.reduce((s, t) => s + (t === 'p2tr' ? 57.5 : inputVbytes(t)), 0);
  const outs = outTypes.reduce((s, t) => s + outputVbytes(t), 0);
  return Math.ceil(overhead + ins + outs);
}

function varIntSize(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    const j = r[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const SEQUENCE_RBF = 0xfffffffd;
export const SEQUENCE_FINAL_LOCKTIME = 0xfffffffe;

/**
 * Build and sign. Inputs and outputs are shuffled (Cake: BitcoinOrdering.shuffle)
 * unless `keepOrder` is set; RBF is signalled unless disabled.
 */
export function buildTransaction(net: UtxoNetwork, inputs: SpendInput[], outputs: SpendOutput[], opts: { rbf: boolean; locktime: number; keepOrder?: boolean }): BuiltTx {
  const ins = opts.keepOrder ? inputs : shuffle(inputs);
  const outs = opts.keepOrder ? outputs : shuffle(outputs);
  const fee = ins.reduce((s, i) => s + i.value, 0n) - outs.reduce((s, o) => s + o.value, 0n);
  if (fee < 0n) throw new Error('Outputs exceed inputs');
  if (net.coin === 'bch') {
    const r = buildBchTransaction(ins, outs, { locktime: opts.locktime });
    return { ...r, fee, inputs: ins, outputs: outs };
  }
  const sn = signerNet(net);
  const tx = new Transaction({ version: net.coin === 'doge' ? 1 : 2, lockTime: opts.locktime, allowLegacyWitnessUtxo: true, lowR: true });
  const sequence = opts.rbf ? SEQUENCE_RBF : opts.locktime > 0 ? SEQUENCE_FINAL_LOCKTIME : 0xffffffff;
  for (const i of ins) {
    const script = addressToScript(net, i.address);
    const base: any = { txid: i.txid, index: i.vout, sequence, witnessUtxo: { script, amount: i.value } };
    if (i.type === 'p2sh') base.redeemScript = p2wpkh(i.pubkey, sn).script;
    if (i.type === 'p2tr') base.tapInternalKey = i.pubkey.length === 33 ? i.pubkey.slice(1) : i.pubkey;
    if (i.type === 'p2pkh' && i.prevTxHex) base.nonWitnessUtxo = hex.decode(i.prevTxHex);
    tx.addInput(base);
  }
  for (const o of outs) tx.addOutput({ script: addressToScript(net, o.address), amount: o.value });
  ins.forEach((i, idx) => tx.signIdx(i.privkey, idx));
  tx.finalize();
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize, fee, inputs: ins, outputs: outs };
}

/** p2sh-p2wpkh redeem script helper (for address checks) */
export function p2shP2wpkhAddress(net: UtxoNetwork, pub: Uint8Array): string {
  const sn = signerNet(net);
  return p2sh(p2wpkh(pub, sn), sn).address!;
}
