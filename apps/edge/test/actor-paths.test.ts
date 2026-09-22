// actor-paths.test.ts — branch coverage for resolve-actor's rows that the
// M3 gate matrix did not reach: the payment-signature decode, delegation
// state edges, the session-cookie fallthrough, the row-3 waitUntil sighting
// fan-out, the rDNS row, the cf-signal evidence row, and index.fetch's stub.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import {
  CredentialRejected,
  makeResolveActor,
  type IdentityEnv,
  type ResolveActorDeps,
} from "../src/auth/resolve-actor";
import worker from "../src/index";
import { next } from "./stubs/pg";

const testEnv = () =>
  ({
    ...env,
    HYPERDRIVE_FRESH: { connectionString: "fresh" },
    HYPERDRIVE_CACHED: { connectionString: "cached" },
  }) as unknown as IdentityEnv;

const ctx = () => createExecutionContext();

type SqlRoute = [match: string, rows: Record<string, unknown>[]];
const depsFor = (routes: SqlRoute[]): ResolveActorDeps => ({
  query: async (_connStr, sql, _params) => {
    for (const [match, rows] of routes) if (sql.includes(match)) return rows;
    return [];
  },
});

const DELEGATION = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
  owner_user_id: "00000000-0000-4000-8000-000000000001",
  agent_identity_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
  connector_slug: "openai",
  scopes: ["feed:read"],
  requires_approval: true,
  state: "active",
  expires_at: null,
  quarantined_until: null,
  declared_intent: null as string | null,
};

const BEARER = "Bearer mb_dlg_0000000000000000000000000000beef";

const PAYMENT = btoa(
  JSON.stringify({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "100",
      asset: "0x00000000000000000000000000000000000000aa",
      payTo: "0x00000000000000000000000000000000000000bb",
      maxTimeoutSeconds: 60,
    },
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: `0x${"11".repeat(20)}`,
        to: `0x${"22".repeat(20)}`,
        value: "100",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"00".repeat(32)}`,
      },
    },
  }),
);

afterEach(() => vi.unstubAllGlobals());

describe("paymentFrom branch coverage", () => {
  it("a valid payment-signature populates payment + http transport", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const a = await resolveActor(
      new Request("https://musebook.dev/x", {
        headers: { "payment-signature": PAYMENT },
      }),
    );
    expect(a.payment?.x402Version).toBe(2);
    expect(a.paymentTransport).toBe("http");
  });

  it("garbage and schema-invalid signatures both land on null", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    for (const raw of [btoa("{not json"), btoa(JSON.stringify({ x402Version: 1 }))]) {
      const a = await resolveActor(
        new Request("https://musebook.dev/x", {
          headers: { "payment-signature": raw },
        }),
      );
      expect(a.payment).toBeNull();
      expect(a.paymentTransport).toBeNull();
    }
  });
});

describe("delegation row-1 edges", () => {
  it("non-active and expired rows reject", async () => {
    for (const row of [
      { ...DELEGATION, state: "revoked" },
      { ...DELEGATION, expires_at: "2020-01-01T00:00:00Z" },
    ]) {
      const resolveActor = makeResolveActor(
        testEnv(),
        ctx(),
        depsFor([["resolve_delegation", [row]]]),
      );
      await expect(
        resolveActor(new Request("https://musebook.dev/x", { headers: { authorization: BEARER } })),
      ).rejects.toBeInstanceOf(CredentialRejected);
    }
  });

  it("declared_intent train and null both land correctly", async () => {
    for (const [intent, expected] of [
      ["train", "train"],
      [null, "read"],
    ] as const) {
      const resolveActor = makeResolveActor(
        testEnv(),
        ctx(),
        depsFor([["resolve_delegation", [{ ...DELEGATION, declared_intent: intent }]]]),
      );
      const a = await resolveActor(
        new Request("https://musebook.dev/x", { headers: { authorization: BEARER } }),
      );
      expect(a.declaredIntent).toBe(expected);
    }
  });
});

describe("session row-2 fallthrough and row-6 default", () => {
  it("an unrecognized mb_session cookie falls through to human_reader", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const a = await resolveActor(
      new Request("https://musebook.dev/x", { headers: { cookie: "mb_session=deadbeef" } }),
    );
    expect(a.class).toBe("human_reader");
  });
});

describe("row-3 sighting fan-out", () => {
  const AGENT = "https://agent-sight.test";

  async function seed(origin: string) {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pubJwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
    const now = Math.floor(Date.now() / 1000);
    await env.WBA_DIR.put("wba:allow", JSON.stringify([origin]));
    await env.WBA_DIR.put(
      `wba:dir:${origin}`,
      JSON.stringify({
        keys: [{ kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: pubJwk.x }],
        fresh: now + 300,
        stale: now + 604_800,
      }),
    );
    const privJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
    return signerFromJWK(privJwk);
  }

  async function signed(signer: Awaited<ReturnType<typeof signerFromJWK>>) {
    const req = new Request("https://musebook.dev/post/x", {
      headers: { "Signature-Agent": `key1="${AGENT}"` },
    });
    const fields = await sign(req, {
      signer,
      expires: new Date(Date.now() + 60_000),
      signatureAgentKey: "key1",
    });
    const out = new Request(req);
    out.headers.set("signature", fields.signature);
    out.headers.set("signature-input", fields.signatureInput);
    return out;
  }

  it("identity hit sends the enqueued job id to Q_CLASSIFY", async () => {
    const e = testEnv();
    const sent: unknown[] = [];
    (e.Q_CLASSIFY as unknown as { send: (m: unknown) => Promise<void> }).send = async (m) => {
      sent.push(m);
    };
    const signer = await seed(AGENT);
    const c = ctx();
    const resolveActor = makeResolveActor(
      e,
      c,
      depsFor([
        [
          "read_agent_identity",
          [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000aa", wallet_address: null }],
        ],
        ["enqueue_sighting", [{ job_id: 7 }]],
      ]),
    );
    const a = await resolveActor(await signed(signer));
    expect(a.class).toBe("crawler_agent");
    expect(a.agentIdentityId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-0000000000aa");
    await waitOnExecutionContext(c);
    expect(sent).toEqual([{ job_id: 7 }]);
  });

  it("no identity row + no job id still resolves and skips the send", async () => {
    const e = testEnv();
    const sent: unknown[] = [];
    (e.Q_CLASSIFY as unknown as { send: (m: unknown) => Promise<void> }).send = async (m) => {
      sent.push(m);
    };
    const signer = await seed(AGENT);
    const c = ctx();
    const resolveActor = makeResolveActor(e, c, depsFor([]));
    const a = await resolveActor(await signed(signer));
    expect(a.class).toBe("crawler_agent");
    expect(a.agentIdentityId).toBeNull();
    await waitOnExecutionContext(c);
    expect(sent).toEqual([]);
  });

  it("an enqueue failure is logged and dropped, never thrown", async () => {
    const signer = await seed(AGENT);
    const c = ctx();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const actor = makeResolveActor(testEnv(), c, {
      query: async (_c: string, sql: string) => {
        if (sql.includes("enqueue_sighting")) throw new Error("db down");
        return [];
      },
    });
    const a = await actor(await signed(signer));
    expect(a.class).toBe("crawler_agent");
    await waitOnExecutionContext(c);
    expect(err).toHaveBeenCalledWith("sighting_enqueue_deferred", expect.any(String));
    err.mockRestore();
  });
});

describe("row-4 rDNS path and row-5 cf signals", () => {
  it("no cf-connecting-ip skips the rDNS row entirely", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const a = await resolveActor(
      new Request("https://musebook.dev/x", { headers: { "user-agent": "GPTBot" } }),
    );
    expect(a.class).toBe("human_reader");
  });

  it("verified GPTBot resolves to crawler_agent", async () => {
    // Route the worker's own DoH calls through the same stub rdns.test.ts uses.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const name = decodeURIComponent(/name=([^&]+)/.exec(url)?.[1] ?? "");
        const data =
          name === "4.3.2.1.in-addr.arpa"
            ? ["crawl.openai.com."]
            : name === "crawl.openai.com."
              ? ["1.2.3.4"]
              : [];
        return Promise.resolve(
          new Response(JSON.stringify({ Answer: data.map((d) => ({ data: d })) }), { status: 200 }),
        );
      }),
    );
    const resolveActor = makeResolveActor(
      testEnv(),
      ctx(),
      depsFor([["read_agent_identity", [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000bb" }]]]),
    );
    const a = await resolveActor(
      new Request("https://musebook.dev/x", {
        headers: { "cf-connecting-ip": "1.2.3.4", "user-agent": "GPTBot" },
      }),
    );
    expect(a.class).toBe("crawler_agent");
    expect(a.verification).toBe("verified_crawler");
    expect(a.agentIdentityId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-0000000000bb");
  });

  it("cf.verifiedBot + score land as evidence, class stays crawler_agent none", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const req = new Request("https://musebook.dev/x", {
      headers: { "user-agent": "SomeBot/1.0" },
    });
    Object.defineProperty(req, "cf", {
      value: { verifiedBot: true, verifiedBotCategory: "search", score: 42 },
    });
    const a = await resolveActor(req);
    expect(a.class).toBe("crawler_agent");
    expect(a.verification).toBe("none");
    expect(a.evidence[0]!.kind).toBe("cf_verified_bot");
    expect(a.evidence.map((e) => e.kind)).toEqual([
      "cf_verified_bot",
      "ua_declared",
      "cf_bot_score",
    ]);
  });

  it("a score-only cf object still records evidence", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const req = new Request("https://musebook.dev/x");
    Object.defineProperty(req, "cf", { value: { score: 7 } });
    const a = await resolveActor(req);
    expect(a.evidence.map((e) => e.kind)).toEqual(["ua_declared", "cf_bot_score"]);
  });
});

describe("production pg path (no deps.query)", () => {
  it("withClient connects, queries, and returns the delegation row", async () => {
    next.result = [DELEGATION];
    next.error = null;
    const resolveActor = makeResolveActor(testEnv(), ctx());
    const a = await resolveActor(
      new Request("https://musebook.dev/x", { headers: { authorization: BEARER } }),
    );
    expect(a.class).toBe("owner_agent");
    next.error = new Error("db down");
    await expect(
      resolveActor(new Request("https://musebook.dev/x", { headers: { authorization: BEARER } })),
    ).rejects.toThrow("db down");
    next.error = null;
  });
});

describe("index.fetch pass-through", () => {
  it("forwards a non-resource path to the origin untouched", async () => {
    // M6's real fetch: / is not a resource URL, so the Worker proxies it — the
    // stub returns a marker the origin is responsible for, byte for byte.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("origin-body", { status: 200 }))),
    );
    const res = await worker.fetch(new Request("https://musebook.dev/"), testEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("origin-body");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
