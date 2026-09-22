// apps/edge/test/gate/m8-wire.test.ts — §16.5 M8 items 1/2/5 on the wire:
// a real 402 -> a really-signed EIP-712 authorization -> the facilitator's
// real verify + settle on Base Sepolia -> 200 with the body, the settlement
// row flipped, the three legs posted, and the grant honesty per mode.
// External prerequisites: X402_TEST_PAYER_KEY in the env (a funded testnet
// EOA — the check skips loudly, never silently, per §17.6).
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentRequired } from "@musebook/x402";
import type { PaymentPayload } from "@musebook/schema";
import { db, signedBotAuthHeaders } from "./helpers.js";

const KEY = (env as unknown as Record<string, string>).X402_TEST_PAYER_KEY;
const haveKey = KEY !== undefined && KEY !== "missing" && KEY.startsWith("0x");
const NETWORK = "eip155:84532";

const PAYER_KEY_MISSING =
  "SKIPPED-EXTERNAL: X402_TEST_PAYER_KEY unset — the §16.5 M8.1/2/5 live " +
  "checks need a funded Base Sepolia EOA (H9); set it in .env and re-run.";

interface Accepted {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Sign a TransferWithAuthorization for the requirements the 402 itself
 *  served — `accepted` echoes the wire object verbatim so quoteId and the
 *  EIP-712 domain triple travel exactly as the Worker issued them (§6.7.6). */
async function signFor(accepted: Accepted, domainName?: string): Promise<PaymentPayload> {
  const account = privateKeyToAccount(KEY as `0x${string}`);
  const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const signature = await account.signTypedData({
    domain: {
      name: domainName ?? (accepted.extra.name as string),
      version: accepted.extra.version as string,
      chainId: Number(accepted.network.split(":")[1]),
      verifyingContract: accepted.asset as `0x${string}`,
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
    message: {
      from: account.address,
      to: accepted.payTo as `0x${string}`,
      value: BigInt(accepted.amount),
      validAfter: 0n,
      validBefore,
      nonce: nonce as `0x${string}`,
    },
  });
  return {
    x402Version: 2,
    accepted: accepted as PaymentPayload["accepted"],
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
}

const signatureHeader = (p: PaymentPayload): string => btoa(JSON.stringify(p));

describe("M8.1/2/5 — real facilitator round trip through the Worker", () => {
  beforeAll(async () => {
    if (!haveKey) throw new Error(PAYER_KEY_MISSING);
    // The durable grant this suite mints survives the run (that is the point),
    // so a re-run must clear it or the first fetch reads as grant-held rather
    // than 402. The crawler's identity id is the seed's constant.
    await db(
      `delete from public.access_grants
        where post_id = '44444444-4444-4444-8444-000000000002'
          and subject_agent_id = '33333333-3333-4333-8333-000000000002'`,
    );
  });

  it("x402_always: 402 names the treasury + network, replay pays and 200s", async () => {
    const url = "https://musebook.dev/p/seed-note-x402.md";
    const denied = await SELF.fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (m8-round-trip)" },
    });
    expect(denied.status).toBe(402);
    const req = decodePaymentRequired(denied.headers.get("PAYMENT-REQUIRED"));
    expect(req).not.toBeNull();
    const accepted = req!.accepts[0] as Accepted;
    // The 402 names the treasury and the configured network — nothing else.
    expect(accepted.payTo.toLowerCase()).toBe(
      (env as unknown as Record<string, string>).X402_PAY_TO.toLowerCase(),
    );
    expect(accepted.network).toBe(NETWORK);
    expect(accepted.scheme).toBe("exact");
    expect(accepted.extra.quoteId).toBeDefined();

    const payment = await signFor(accepted);

    // M8.2 — fire the paid request TOGETHER with 100 replays of the same
    // signed authorization. Exactly one of them wins insert_pending_settlement
    // and settles; the rest observe the no-second-settle result: a 409 while
    // the row is in flight, a 200 idempotent replay inside the 120 s window,
    // or a 402 re-challenge once the quote is consumed (the replayed
    // `extra.quoteId` resolves to a consumed quote → no_matching_quote → a
    // fresh quote is attached, so the client can simply pay again rather than
    // hold a dead quote). What can never happen is a second facilitator
    // settle — the nonce claim is a unique index.
    const headers = {
      "user-agent": "Mozilla/5.0 (m8-round-trip)",
      "payment-signature": signatureHeader(payment),
    };
    const all = await Promise.all(Array.from({ length: 101 }, () => SELF.fetch(url, { headers })));
    const statuses = all.map((r) => r.status);
    console.log("REPLAY STATUS MIX:", JSON.stringify(statuses));
    for (const s of statuses) expect([200, 402, 409]).toContain(s);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);

    const winner = all[statuses.indexOf(200)]!;
    const body = await winner.text();
    expect(body.length).toBeGreaterThan(50);
    // The settlement receipt travels back on the 200 (§6.8).
    expect(winner.headers.get("PAYMENT-RESPONSE")).not.toBeNull();

    // The row flipped: settled, this nonce, this tx hash — exactly one.
    const rows = await db<{ status: string; transaction: string | null }>(
      "select status, transaction from public.x402_settlements where nonce = $1",
      [payment.payload.authorization.nonce],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("settled");
    expect(rows[0]!.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    // M8.5 negative half — an x402_always purchase mints NO durable grant.
    const grants = await db<{ n: string }>(
      `select count(*)::text as n from public.access_grants g
         join public.posts p on p.id = g.post_id
        where p.slug = 'seed-note-x402'`,
    );
    expect(grants[0]!.n).toBe("0");
  }, 180_000);

  it("human_free_agent_paid: agent settles, a durable grant lands bound to content_hash", async () => {
    const url = "https://musebook.dev/p/seed-note-hfap.md";
    const authHeaders = await signedBotAuthHeaders(url);
    const denied = await SELF.fetch(url, { headers: authHeaders });
    expect(denied.status).toBe(402);
    const req = decodePaymentRequired(denied.headers.get("PAYMENT-REQUIRED"));
    expect(req).not.toBeNull();
    const accepted = req!.accepts[0] as Accepted;

    const before = await db<{ n: string }>(
      `select count(*)::text as n from public.access_grants g
         join public.posts p on p.id = g.post_id and p.slug = 'seed-note-hfap'`,
    );

    const payment = await signFor(accepted);
    const paid = await SELF.fetch(url, {
      headers: { ...authHeaders, "payment-signature": signatureHeader(payment) },
    });
    expect(paid.status).toBe(200);

    // M8.5 positive half — the settled hfap purchase left an access_grants row
    // bound to the post's content_hash with the subject = the crawler agent.
    const grants = await db<{ content_hash: string; payer: string }>(
      `select g.content_hash, g.payer from public.access_grants g
         join public.posts p on p.id = g.post_id and p.slug = 'seed-note-hfap'`,
    );
    expect(grants.length).toBe(Number(before[0]!.n) + 1);
    const post = await db<{ content_hash: string }>(
      "select content_hash from public.posts where slug = 'seed-note-hfap'",
    );
    const mine = grants.find((g) => g.content_hash === post[0]!.content_hash);
    expect(mine).toBeDefined();
    expect(mine!.payer.toLowerCase()).toBe(payment.payload.authorization.from.toLowerCase());

    // The same agent now holds a live grant: re-fetch without payment → 200.
    const again = await SELF.fetch(url, { headers: authHeaders });
    expect(again.status).toBe(200);
  }, 180_000);

  // M8.7 negative half — a signature minted under the WRONG EIP-712 domain
  // name ("USD Coin", the mainnet name, on the sepolia asset whose real name
  // is "USDC") is a different domain separator: the facilitator must reject
  // it before any nonce claim. The echoed `accepted` stays verbatim so this
  // isolates the domain check, not quote matching.
  it("wrong-domain signature is rejected by the facilitator", async () => {
    const url = "https://musebook.dev/p/seed-note-x402.md";
    const denied = await SELF.fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (m8-bad-domain)" },
    });
    expect(denied.status).toBe(402);
    const req = decodePaymentRequired(denied.headers.get("PAYMENT-REQUIRED"));
    expect(req).not.toBeNull();
    const accepted = req!.accepts[0] as Accepted;

    const payment = await signFor(accepted, "USD Coin");
    const res = await SELF.fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (m8-bad-domain)",
        "payment-signature": signatureHeader(payment),
      },
    });
    expect(res.status).toBe(402);
    const challenge = decodePaymentRequired(res.headers.get("PAYMENT-REQUIRED"));
    console.log("WRONG-DOMAIN ERROR:", challenge?.error);
    // D65 — the plan names `invalid_exact_evm_payload_signature`; x402.org
    // actually returns `invalid_exact_evm_signature`. Match the prefix.
    expect(challenge?.error ?? "").toMatch(/invalid_exact_evm/);

    // And the rejection happened before any settlement: the nonce was never
    // claimed.
    const rows = await db<{ n: string }>(
      "select count(*)::text as n from public.x402_settlements where nonce = $1",
      [payment.payload.authorization.nonce],
    );
    expect(rows[0]!.n).toBe("0");
  }, 180_000);
});
