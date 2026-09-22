// packages/x402/src/assets.ts
// Verified 2026-09-21 against @x402/evm@2.26.0 src/defaultAssets.ts, the legacy
// x402@1.2.0 config, and Circle's FiatTokenV2_2._domainSeparator().

export interface AssetConfig {
  readonly asset: string;
  readonly name: string; // EIP-712 domain name == the ERC-20 name() on chain
  readonly version: string; // EIP-712 domain version
  readonly decimals: number;
  readonly symbol: string;
}

export const X402_ASSETS: Readonly<Record<string, AssetConfig>> = {
  "eip155:8453": {
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin", // <-- NOT "USDC". Base MAINNET USDC's on-chain name() is "USD Coin".
    version: "2",
    decimals: 6,
    symbol: "USDC",
  },
  "eip155:84532": {
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC", // <-- genuinely "USDC" on Base Sepolia. Do not "fix" this.
    version: "2",
    decimals: 6,
    symbol: "USDC",
  },
};
