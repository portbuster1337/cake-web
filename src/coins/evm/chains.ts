// The six EVM chains of Cake Wallet (cw_evm/lib/evm_chain_registry.dart,
// cw_evm/lib/utils/evm_chain_utils.dart, cw_evm/lib/clients/*_client.dart).

import type { WalletType } from '../types.ts';

export type EvmPriority = 'slow' | 'medium' | 'fast';

export interface EvmChain {
  type: WalletType;
  chainId: number;
  name: string;
  /** CryptoCurrency key of the native coin */
  currency: string;
  /** token tag (Erc20Token.tag) */
  tag: string;
  explorer: string;
  /** fee currency symbol (getFeeCurrency) */
  feeSymbol: string;
  /** priority fee in wei per priority (getTotalPriorityFee) */
  priorityFee: (p: EvmPriority) => bigint;
  hasPriorityFee: boolean;
  /** Ethereum sends EIP-1559 (type 2) transactions; the other chains legacy EIP-155 ones with gasPrice = maxFeePerGas */
  eip1559: boolean;
  /** Moralis chain name (token discovery) */
  moralis?: string;
  /** token used for the ERC-20 fee estimate (_getUSDCContractAddress) */
  usdc: string;
  /** Settings key of the "<Scan> history" toggle */
  scanSetting: 'useEtherscan' | 'usePolygonScan' | 'useBaseScan' | 'useArbiScan' | 'useBscScan' | 'useRobinhoodScan';
  /** keyless history fallback (Blockscout's Etherscan-compatible API), used only without an Etherscan key */
  blockscout?: string;
}

const GWEI = 1_000_000_000n;
const MWEI = 1_000_000n;
const TIP: Record<EvmPriority, bigint> = { slow: 1n, medium: 2n, fast: 4n };
const tipGwei = (p: EvmPriority) => TIP[p] * GWEI;

export const EVM_CHAINS: Record<string, EvmChain> = {
  ethereum: { type: 'ethereum', chainId: 1, name: 'Ethereum', currency: 'eth', tag: 'ETH', explorer: 'https://etherscan.io', feeSymbol: 'ETH', priorityFee: tipGwei, hasPriorityFee: true, eip1559: true, moralis: 'eth', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', scanSetting: 'useEtherscan', blockscout: 'https://eth.blockscout.com/api' },
  polygon: { type: 'polygon', chainId: 137, name: 'Polygon', currency: 'maticpoly', tag: 'POL', explorer: 'https://polygonscan.com', feeSymbol: 'POL', priorityFee: (p) => 25n * GWEI + { slow: 0n, medium: 15n, fast: 35n }[p] * GWEI, hasPriorityFee: true, eip1559: false, moralis: 'polygon', usdc: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', scanSetting: 'usePolygonScan', blockscout: 'https://polygon.blockscout.com/api' },
  base: { type: 'base', chainId: 8453, name: 'Base', currency: 'baseEth', tag: 'BASE', explorer: 'https://basescan.org', feeSymbol: 'ETH', priorityFee: (p) => ({ slow: 1n, medium: 3n, fast: 5n })[p] * MWEI, hasPriorityFee: true, eip1559: false, moralis: 'base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', scanSetting: 'useBaseScan', blockscout: 'https://base.blockscout.com/api' },
  arbitrum: { type: 'arbitrum', chainId: 42161, name: 'Arbitrum', currency: 'arbEth', tag: 'ARB', explorer: 'https://arbiscan.io', feeSymbol: 'ETH', priorityFee: () => 0n, hasPriorityFee: false, eip1559: false, moralis: 'arbitrum', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', scanSetting: 'useArbiScan', blockscout: 'https://arbitrum.blockscout.com/api' },
  bsc: { type: 'bsc', chainId: 56, name: 'BNB Smart Chain', currency: 'bnb', tag: 'BSC', explorer: 'https://bscscan.com', feeSymbol: 'BNB', priorityFee: tipGwei, hasPriorityFee: true, eip1559: false, moralis: 'bsc', usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', scanSetting: 'useBscScan' },
  robinhood: { type: 'robinhood', chainId: 4663, name: 'Robinhood Chain', currency: 'robEth', tag: 'ROB', explorer: 'https://robinhoodchain.blockscout.com', feeSymbol: 'ETH', priorityFee: () => 0n, hasPriorityFee: false, eip1559: false, usdc: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', scanSetting: 'useRobinhoodScan', blockscout: 'https://robinhoodchain.blockscout.com/api' },
};

export function chainOf(type: WalletType): EvmChain {
  const c = EVM_CHAINS[type];
  if (!c) throw new Error(`${type} is not an EVM chain`);
  return c;
}

export function chainById(id: number): EvmChain | undefined {
  return Object.values(EVM_CHAINS).find((c) => c.chainId === id);
}

/** computeBufferedMaxFeePerGasWei */
export function bufferedMaxFeePerGas(baseFee: bigint | null, gasPrice: bigint, priorityFee: bigint, chainHasPriorityFee: boolean): bigint {
  if (baseFee !== null && baseFee > 0n) {
    const b = baseFee + priorityFee;
    const pct = (b * (chainHasPriorityFee ? 115n : 105n)) / 100n;
    const min = b + b / 100n;
    return pct > min ? pct : min;
  }
  return gasPrice + priorityFee;
}

/** methodSignatureToType (evm_chain_wallet.dart) */
export const METHOD_SIGNATURES: Record<string, string> = {
  '0x095ea7b3': 'approval',
  '0xa9059cbb': 'transfer',
  '0x23b872dd': 'transferFrom',
  '0x9be111d1': 'smartSwap',
  '0x5327a3d2': 'crossChainSwap',
  '0x205030b2': 'routerExecution',
  '0x5ad29efa': 'relayedExecution',
  '0x574da717': 'transferOut',
  '0x2e1a7d4d': 'withdraw',
  '0x7ff36ab5': 'swapExactETHForTokens',
  '0x40c10f19': 'mint',
  '0x44bc937b': 'depositWithExpiry',
  '0xd0e30db0': 'deposit',
  '0xe8e33700': 'addLiquidity',
  '0xd505accf': 'permit',
};
