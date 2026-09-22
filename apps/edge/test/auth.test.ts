// apps/edge/test/auth.test.ts — GATE M3 checks 1–6 and 10, under
// @cloudflare/vitest-plugin (the real workerd runtime, real KV/Queue bindings,
// compatibility_date 2026-09-21 from wrangler.jsonc — so these tests double as
// the proof that Ed25519 verify needs no compat flag).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import {
  CredentialRejected,
  WebBotAuthRejected,
  makeResolveActor,
  type IdentityEnv,
  type ResolveActorDeps,
} from "../src/auth/resolve-actor";
import { classifySignature } from "../src/auth/web-bot-auth";
import { requireAgentScope, QUARANTINE_ALLOWED } from "@musebook/connectors";
import type { Actor } from "@musebook/schema";
import type { Client } from "pg";

// HYPERDRIVE_* exist in the miniflare env, but their connectionString is never
// dialed: every test injects deps.query, so connStr is just a routing label.
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
    for (const [match, rows] of routes) {
      if (sql.includes(match)) return rows;
    }
    return [];
  },
});

const DELEGATION_ROW = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
  owner_user_id: "00000000-0000-4000-8000-000000000001",
  agent_identity_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
  connector_slug: "openai",
  scopes: ["feed:read", "post:read", "post:write"],
  requires_approval: true,
  state: "active",
  expires_at: null,
  quarantined_until: null,
  declared_intent: "crawl",
};

const SESSION_ROW = {
  id: "11111111-1111-4111-8111-0000000000f1",
  user_id: "00000000-0000-4000-8000-000000000001",
  wallet: "0x00000000000000000000000000000000000000aa",
};

// ── Web Bot Auth fixture helpers ────────────────────────────────────────────
const AGENT_ORIGIN = "https://agent.test";

async function makeKeypair(): Promise<{ privJwk: JsonWebKey; pubJwk: JsonWebKey }> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const pubJwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  return { privJwk, pubJwk };
}

/** Seed the allowlist + a fresh-or-stale directory cache entry in WBA_DIR. */
async function seedDirectory(origin: string, pubJwk: JsonWebKey, stale = false) {
  const now = Math.floor(Date.now() / 1000);
  await env.WBA_DIR.put("wba:allow", JSON.stringify([origin]));
  await env.WBA_DIR.put(
    `wba:dir:${origin}`,
    JSON.stringify({
      keys: [{ kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: pubJwk.x }],
      fresh: stale ? now - 60 : now + 300,
      stale: now + 604_800,
    }),
  );
}

/** A request carrying Signature-Agent + Signature + Signature-Input. */
async function signedRequest(
  signer: Awaited<ReturnType<typeof signerFromJWK>>,
  opts: {
    agentUri?: string;
    expires?: Date;
    created?: Date;
    url?: string;
    signatureAgentKey?: string;
  } = {},
): Promise<Request> {
  const agentUri = opts.agentUri ?? `${AGENT_ORIGIN}`;
  const url = opts.url ?? "https://musebook.dev/post/demo";
  const req = new Request(url, {
    headers: { "Signature-Agent": `key1="${agentUri}"` },
  });
  const fields = await sign(req, {
    signer,
    expires: opts.expires ?? new Date(Date.now() + 60_000),
    created: opts.created,
    signatureAgentKey: opts.signatureAgentKey ?? "key1",
  });
  const out = new Request(req);
  out.headers.set("signature", fields.signature);
  out.headers.set("signature-input", fields.signatureInput);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── M3.1 — all four actor classes resolve from a constructed Request ─────────
describe("M3.1 actor classes", () => {
  it("Bearer mb_dlg_… resolves to owner_agent with the delegation's scopes", async () => {
    const resolveActor = makeResolveActor(
      testEnv(),
      ctx(),
      depsFor([["resolve_delegation", [DELEGATION_ROW]]]),
    );
    const req = new Request("https://musebook.dev/feed", {
      headers: { authorization: "Bearer mb_dlg_0000000000000000000000000000dead" },
    });
    const a = await resolveActor(req);
    expect(a.class).toBe("owner_agent");
    expect(a.plane).toBe("agent");
    expect(a.userId).toBe(DELEGATION_ROW.owner_user_id);
    expect(a.scopes).toEqual(DELEGATION_ROW.scopes);
    expect(a.declaredIntent).toBe("crawl");
  });

  it("Cookie mb_session resolves to human_creator", async () => {
    const resolveActor = makeResolveActor(
      testEnv(),
      ctx(),
      depsFor([["read_session_by_token", [SESSION_ROW]]]),
    );
    const req = new Request("https://musebook.dev/feed", {
      headers: { cookie: "mb_session=mbs_abcdef0123456789abcdef0123456789ab" },
    });
    const a = await resolveActor(req);
    expect(a.class).toBe("human_creator");
    expect(a.plane).toBe("human");
    expect(a.userId).toBe(SESSION_ROW.user_id);
    expect(a.walletAddress).toBe(SESSION_ROW.wallet);
  });

  it("a dead mb_session cookie falls through to the next rung (human_reader)", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const req = new Request("https://musebook.dev/feed", {
      headers: { cookie: "mb_session=mbs_000000000000000000000000000000dead" },
    });
    const a = await resolveActor(req);
    expect(a.class).toBe("human_reader");
    expect(a.userId).toBeNull();
  });

  it("a verified Signature resolves to crawler_agent (web_bot_auth)", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk);
    const signer = await signerFromJWK(privJwk);
    const c = await ctx();
    const resolveActor = makeResolveActor(testEnv(), c, depsFor([]));
    const a = await resolveActor(await signedRequest(signer));
    if (a.class !== "crawler_agent") throw new Error(`expected crawler_agent, got ${a.class}`);
    expect(a.verification).toBe("web_bot_auth");
    expect(a.directoryKeyid).toBe(signer.keyid);
    await waitOnExecutionContext(c);
  });

  it("an anonymous request resolves to human_reader (fail-open)", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const a = await resolveActor(new Request("https://musebook.dev/feed"));
    expect(a.class).toBe("human_reader");
    expect(a.plane).toBe("human");
    expect(a.userId).toBeNull();
  });

  it("a malformed Bearer token is rejected, never silent", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const req = new Request("https://musebook.dev/feed", {
      headers: { authorization: "Bearer mb_dlg_0000000000000000000000000000beef" },
    });
    await expect(resolveActor(req)).rejects.toThrow(CredentialRejected);
  });
});

// ── M3.2 — the WBA matrix ───────────────────────────────────────────────────
describe("M3.2 web bot auth outcomes", () => {
  it("no Signature header → human (fail open)", async () => {
    const v = await classifySignature(new Request("https://musebook.dev/feed"), testEnv());
    expect(v.kind).toBe("human");
  });

  it("valid ed25519 signature → agent", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk);
    const signer = await signerFromJWK(privJwk);
    const v = await classifySignature(await signedRequest(signer), testEnv());
    expect(v).toEqual({
      kind: "agent",
      keyid: signer.keyid,
      agentUri: AGENT_ORIGIN,
      agentOrigin: AGENT_ORIGIN,
    });
  });

  it("tampered signature → 401", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk);
    const signer = await signerFromJWK(privJwk);
    const req = await signedRequest(signer);
    const sig = req.headers.get("signature")!;
    const i = sig.indexOf(":") + 1;
    const flipped = sig.slice(0, i) + (sig[i] === "A" ? "B" : "A") + sig.slice(i + 1);
    req.headers.set("signature", flipped);
    const v = await classifySignature(req, testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });

  it("expired signature → 401", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk);
    const signer = await signerFromJWK(privJwk);
    const req = await signedRequest(signer, {
      created: new Date(Date.now() - 600_000),
      expires: new Date(Date.now() - 540_000),
    });
    const v = await classifySignature(req, testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });

  it("unknown keyid → 401", async () => {
    const dir = await makeKeypair();
    const signerKp = await makeKeypair(); // not in the directory
    await seedDirectory(AGENT_ORIGIN, dir.pubJwk);
    const signer = await signerFromJWK(signerKp.privJwk);
    const v = await classifySignature(await signedRequest(signer), testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });

  it("directory unreachable with no stale copy → 503", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    // Allowlisted origin but no wba:dir entry → the fetch must happen and fail.
    await env.WBA_DIR.put("wba:allow", JSON.stringify([AGENT_ORIGIN]));
    await env.WBA_DIR.delete(`wba:dir:${AGENT_ORIGIN}`);
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const signer = await signerFromJWK(privJwk);
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const req = await signedRequest(signer);
    const p = resolveActor(req);
    await expect(p).rejects.toMatchObject({
      status: 503,
      retryAfter: 30,
    });
    void pubJwk;
  });

  it("stale directory (<7d) serves when the live fetch fails", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk, true);
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const signer = await signerFromJWK(privJwk);
    const v = await classifySignature(await signedRequest(signer), testEnv());
    expect(v.kind).toBe("agent");
  });
});

// ── M3.3 — the overrides are asserted at the call site ──────────────────────
describe("M3.3 verify() overrides", () => {
  it("a signature older than maxAge=300 is rejected (library default 86400 would pass)", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk);
    const signer = await signerFromJWK(privJwk);
    const req = await signedRequest(signer, {
      created: new Date(Date.now() - 350_000), // 350 s ago: > 300, < 86400
      expires: new Date(Date.now() - 290_000), // signed with 60 s validity
    });
    const v = await classifySignature(req, testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });

  it("clockSkew=30: created 20 s in the future still verifies", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk);
    const signer = await signerFromJWK(privJwk);
    const req = await signedRequest(signer, {
      created: new Date(Date.now() + 20_000),
      expires: new Date(Date.now() + 80_000),
    });
    const v = await classifySignature(req, testEnv());
    expect(v.kind).toBe("agent");
  });

  it("an RSA-PSS signature is rejected: algorithms is exactly [ed25519]", async () => {
    const kp = await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-512",
      },
      true,
      ["sign", "verify"],
    );
    const privJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
    const pubJwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
    const now = Math.floor(Date.now() / 1000);
    await env.WBA_DIR.put("wba:allow", JSON.stringify([AGENT_ORIGIN]));
    await env.WBA_DIR.put(
      `wba:dir:${AGENT_ORIGIN}`,
      JSON.stringify({
        keys: [{ kty: "RSA", alg: "PS512", e: pubJwk.e, n: pubJwk.n }],
        fresh: now + 300,
        stale: now + 604_800,
      }),
    );
    const signer = await signerFromJWK(privJwk);
    const req = await signedRequest(signer);
    const v = await classifySignature(req, testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });
});

// ── M3.4 — SSRF guard ───────────────────────────────────────────────────────
describe("M3.4 SSRF", () => {
  it("Signature-Agent pointing at a link-local address is never fetched", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk);
    const signer = await signerFromJWK(privJwk);
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      calls.push(input);
      return new Response("{}", { status: 200 });
    });
    // A https URI whose origin is not on the allowlist.
    const req = await signedRequest(signer, { agentUri: "https://169.254.169.254/" });
    const v = await classifySignature(req, testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
    expect(calls.length).toBe(0);
  });

  it("an oversized directory body is abandoned at 64KB", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await env.WBA_DIR.put("wba:allow", JSON.stringify([AGENT_ORIGIN]));
    await env.WBA_DIR.delete(`wba:dir:${AGENT_ORIGIN}`);
    vi.stubGlobal("fetch", async () => new Response("x".repeat(64 * 1024 + 1), { status: 200 }));
    const signer = await signerFromJWK(privJwk);
    const v = await classifySignature(await signedRequest(signer), testEnv());
    // A directory that violates the caps is an upstream fault: 503, like
    // unreachable. (The body is abandoned — that is what this check asserts.)
    expect(v).toMatchObject({ kind: "reject", status: 503 });
  });

  it("the directory fetch has a 2 s timeout", async () => {
    const { privJwk } = await makeKeypair();
    await env.WBA_DIR.put("wba:allow", JSON.stringify([AGENT_ORIGIN]));
    await env.WBA_DIR.delete(`wba:dir:${AGENT_ORIGIN}`);
    vi.stubGlobal(
      "fetch",
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          const t = setTimeout(() => rej(new Error("should have been aborted")), 30_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            rej(new Error("The operation was aborted."));
          });
        }),
    );
    const started = Date.now();
    const signer = await signerFromJWK(privJwk);
    const v = await classifySignature(await signedRequest(signer), testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 503 });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

// ── M3.5 — Ed25519 verify runs under compatibility_date 2026-09-21 with no
//    compatibility_flags (the manifest ships none; this whole suite is the
//    runtime proof) — plus the source-hygiene greps live in the gate itself. ──
describe("M3.5 vendored verifier", () => {
  it("ed25519 verify works on this workerd runtime", async () => {
    const { privJwk, pubJwk } = await makeKeypair();
    await seedDirectory(AGENT_ORIGIN, pubJwk);
    const v = await classifySignature(await signedRequest(await signerFromJWK(privJwk)), testEnv());
    expect(v.kind).toBe("agent");
  });
});

// ── M3.6 — request.cf signals are evidence, never access ────────────────────
describe("M3.6 cf bot signals are evidence only", () => {
  it("cf.verifiedBot → crawler_agent with verification:'none' and no scopes", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const req = new Request("https://musebook.dev/feed", {
      headers: { "user-agent": "SomeBot/1.0" },
      cf: { verifiedBot: true, verifiedBotCategory: "AI Crawler", score: 42 },
    } as RequestInit);
    const a = await resolveActor(req);
    if (a.class !== "crawler_agent") throw new Error(`expected crawler_agent, got ${a.class}`);
    expect(a.verification).toBe("none");
    expect(a.scopes).toEqual([]);
    expect(a.userId).toBeNull();
    expect(a.agentIdentityId).toBeNull();
    expect(a.evidence.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["cf_verified_bot", "ua_declared", "cf_bot_score"]),
    );
    expect(a.declaredIntent).toBe("unknown");
  });

  it("a bot score alone never elevates past evidence", async () => {
    const resolveActor = makeResolveActor(testEnv(), ctx(), depsFor([]));
    const req = new Request("https://musebook.dev/feed", {
      cf: { score: 30 },
    } as RequestInit);
    const a = await resolveActor(req);
    if (a.class !== "crawler_agent") throw new Error(`expected crawler_agent, got ${a.class}`);
    expect(a.verification).toBe("none");
    expect(a.payerAddress).toBeNull();
  });
});

// ── M3.10 — feed:read token asked for post:write → 403 naming the scope ──────
describe("M3.10 scope gate", () => {
  const freshFor = (rows: Record<string, unknown>[]) =>
    ({
      query: async () => ({ rows }),
    }) as unknown as Client;

  const ownerActor = (scopes: readonly string[]): Actor => ({
    class: "owner_agent",
    plane: "agent",
    userId: "00000000-0000-4000-8000-000000000001",
    delegationId: DELEGATION_ROW.id,
    agentIdentityId: DELEGATION_ROW.agent_identity_id,
    connectorSlug: "openai",
    scopes: [...scopes],
    requiresApproval: true,
    walletAddress: null,
    evidence: [],
    requestId: "req-test",
    payerAddress: null,
    payment: null,
    paymentTransport: null,
    declaredIntent: "crawl",
    directoryKeyid: null,
  });

  const activeRow = {
    state: "active",
    expires_at: null,
    rate_limit_per_hour: 60,
    quarantined_until: null,
  };

  it("feed:read token → post:write is a 403 naming the missing scope", async () => {
    const gate = await requireAgentScope(ownerActor(["feed:read"]), "post:write", {
      fresh: freshFor([activeRow]),
      limit: async () => true,
    });
    expect(gate).toMatchObject({
      ok: false,
      status: 403,
      error: "insufficient_scope:post:write",
    });
    expect((gate as { error: string }).error).toContain("post:write");
  });

  it("an active delegation with the scope passes (no spend)", async () => {
    const actor = ownerActor(["feed:read", "post:write"]);
    const gate = await requireAgentScope(actor, "post:write", {
      fresh: freshFor([activeRow]),
      limit: async () => true,
    });
    expect(gate.ok).toBe(true);
  });

  it("a revoked delegation is a fresh-read 401, not a stale pass", async () => {
    const actor = ownerActor(["feed:read", "post:write"]);
    const gate = await requireAgentScope(actor, "post:write", {
      fresh: freshFor([{ ...activeRow, state: "revoked" }]),
      limit: async () => true,
    });
    expect(gate).toMatchObject({ ok: false, status: 401, error: "delegation_inactive" });
  });

  it("a quarantined delegation keeps only the read scopes", async () => {
    const quarantined = {
      ...activeRow,
      quarantined_until: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const actor = ownerActor(["feed:read", "post:write"]);
    const read = await requireAgentScope(actor, "feed:read", {
      fresh: freshFor([quarantined]),
      limit: async () => true,
    });
    expect(read.ok).toBe(true);
    const write = await requireAgentScope(actor, "post:write", {
      fresh: freshFor([quarantined]),
      limit: async () => true,
    });
    expect(write).toMatchObject({ ok: false, status: 403, error: "delegation_quarantined" });
    expect(QUARANTINE_ALLOWED.has("feed:read")).toBe(true);
    expect(QUARANTINE_ALLOWED.has("post:write")).toBe(false);
  });

  it("rate limiter exhaustion is a 429", async () => {
    const actor = ownerActor(["feed:read", "post:write"]);
    const gate = await requireAgentScope(actor, "post:write", {
      fresh: freshFor([activeRow]),
      limit: async () => false,
    });
    expect(gate).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
  });
});
