// packages/x402/src/adapters/types.ts — plan.md §6.9, verbatim.
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@musebook/schema";
import type { AssetConfig } from "../assets.js";

/** INBOUND. Speaks x402. Base USDC is the only implementation in v1. */
export interface SettlementAdapter {
  readonly id: string;
  readonly network: string; // CAIP-2
  readonly asset: AssetConfig;
  supports(network: string, scheme: string): boolean;
  buildRequirements(input: {
    amountAtomic: string;
    payTo: string;
    maxTimeoutSeconds: number;
    quoteId: string;
  }): PaymentRequirements;
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse>;
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse>;
}

/** OUTBOUND. Does NOT speak x402. Batched ERC-20 transfers from the treasury. */
export interface PayoutBatchItem {
  readonly ledgerTxId: string;
  readonly toAddress: string;
  readonly amountAtomic: string;
}

export interface PayoutAdapter {
  readonly id: string;
  readonly network: string;
  readonly asset: AssetConfig;
  payout(items: readonly PayoutBatchItem[]): Promise<{
    transaction: string;
    succeeded: readonly string[]; // ledgerTxIds
    failed: ReadonlyArray<{ ledgerTxId: string; reason: string }>;
  }>;
}
