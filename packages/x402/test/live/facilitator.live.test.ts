// test/live/facilitator.live.test.ts — §17.6 T5 live-external tier.
// Runs ONLY when env carries X402_FACILITATOR_URL + X402_TEST_PAYER_KEY
// (a funded Base Sepolia EOA; H9). Silently skipping is a gate failure —
// the M8.1/M8.7 checks report SKIPPED-EXTERNAL loudly, not a pass.
// Each run broadcasts ONE Sepolia settle of MIN_PRICE_ATOMIC — dust, on a
// faucet-funded throwaway wallet.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { FacilitatorClient } from "../../src/facilitator.js";
import { X402_ASSETS } from "../../src/assets.js";
import type { PaymentPayload, PaymentRequirements } from "@musebook/schema";

const URL_ = process.env.X402_FACILITATOR_URL;
const KEY = process.env.X402_TEST_PAYER_KEY;
const NETWORK = process.env.X402_NETWORK ?? "eip155:84532";
const PAY_TO = process.env.X402_PAY_TO ?? "0x1000000000000000000000000000000000000001";

const cfg = X402_ASSETS[NETWORK]!;

async function signPayment(
  domainName: string,
  domainVersion: string,
  amountAtomic = "1000",
): Promise<PaymentPayload> {
  const account = privateKeyToAccount(KEY as `0x${string}`);
  const nonce = `0x${crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`;
  const message = {
    from: account.address,
    to: PAY_TO as `0x${string}`,
    value: BigInt(amountAtomic),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 60),
    nonce: nonce as `0x${string}`,
  };
  const signature = await account.signTypedData({
    domain: {
      name: domainName,
      version: domainVersion,
      chainId: Number(NETWORK.split(":")[1]),
      verifyingContract: cfg.asset as `0x${string}`,
    },
    primaryType: "TransferWithAuthorization",
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    message,
  });
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: NETWORK,
      amount: amountAtomic,
      asset: cfg.asset,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: domainName, version: domainVersion },
    },
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: PAY_TO,
        value: amountAtomic,
        validAfter: "0",
        validBefore: message.validBefore.toString(),
        nonce,
      },
    },
  };
}

const requirements = (domainName = cfg.name, domainVersion = cfg.version): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  amount: "1000",
  asset: cfg.asset,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: domainName, version: domainVersion },
});

describe.runIf(Boolean(URL_ && KEY))("T5 live facilitator round trip", () => {
  const fac = new FacilitatorClient({ url: URL_!, network: NETWORK, timeoutMs: 30_000 });

  it("/supported lists the v2 exact kind for the test network", async () => {
    const s = await fac.supported();
    expect(s.kinds).toContainEqual(
      expect.objectContaining({ x402Version: 2, scheme: "exact", network: NETWORK }),
    );
  });

  it("verify accepts a correctly-signed authorization", async () => {
    const p = await signPayment(cfg.name, cfg.version);
    const r = await fac.verify(p, requirements());
    expect(r.isValid).toBe(true);
  });

  it("a wrong EIP-712 domain signs to invalid_exact_evm_payload_signature", async () => {
    // "USD Coin" is MAINNET's domain name — wrong on Sepolia (§6.7): the
    // signed domain and the requirement's domain diverge, so the signature
    // itself verifies to the wrong contract domain.
    const p = await signPayment("USD Coin", cfg.version);
    const r = await fac.verify(p, requirements());
    expect(r.isValid).toBe(false);
    // x402.org currently reports "invalid_exact_evm_signature" (the plan names
    // the older "invalid_exact_evm_payload_signature" — same rejection family;
    // DEVIATIONS D65).
    expect(r.invalidReason).toMatch(/^invalid_exact_evm/);
  });

  it("settle broadcasts and returns success + a tx hash", async () => {
    const p = await signPayment(cfg.name, cfg.version);
    const r = await fac.settle(p, requirements());
    expect(r.success).toBe(true);
    expect(r.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
