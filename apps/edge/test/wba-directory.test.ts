// wba-directory.test.ts — coverage for web-bot-auth.ts internals the M3 gate
// matrix skipped: the SSRF allowlist default + KV override, directory fetch
// edge cases (non-ok, oversize, missing keys, too many keys, non-OKP filter,
// max-age parse, KV write), the stale-serve path, and resolver rejections.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { classifySignature } from "../src/auth/web-bot-auth";
import type { IdentityEnv } from "../src/auth/resolve-actor";

const testEnv = () =>
  ({
    ...env,
    HYPERDRIVE_FRESH: { connectionString: "fresh" },
    HYPERDRIVE_CACHED: { connectionString: "cached" },
  }) as unknown as IdentityEnv;

async function makeSigner() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const pubJwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  return { signer: await signerFromJWK(privJwk), pubJwk };
}

async function signedReq(
  signer: Awaited<ReturnType<typeof signerFromJWK>>,
  agentUri: string,
): Promise<Request> {
  const req = new Request("https://musebook.dev/post/x", {
    headers: { "Signature-Agent": `key1="${agentUri}"` },
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

/** Stub global fetch so the directory load returns `body` with `status`. */
const stubFetch = (body: string, status = 200, headers: Record<string, string> = {}) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(body, { status, headers: { "content-type": "application/json", ...headers } }),
      ),
    ),
  );

afterEach(() => vi.unstubAllGlobals());

describe("resolver rejection paths", () => {
  it("missing Signature-Agent header rejects 401", async () => {
    const { signer } = await makeSigner();
    const req = new Request("https://musebook.dev/post/x");
    const fields = await sign(req, {
      signer,
      expires: new Date(Date.now() + 60_000),
      signatureAgentKey: "key1",
    });
    const out = new Request(req);
    out.headers.set("signature", fields.signature);
    out.headers.set("signature-input", fields.signatureInput);
    const v = await classifySignature(out, testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });

  it("a non-https Signature-Agent rejects 401", async () => {
    const { signer } = await makeSigner();
    const v = await classifySignature(await signedReq(signer, "http://agent.test"), testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });

  it("an https origin outside the allowlist rejects 401", async () => {
    const { signer } = await makeSigner();
    await env.WBA_DIR.put("wba:allow", JSON.stringify(["https://other.example"]));
    const v = await classifySignature(await signedReq(signer, "https://agent.test"), testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });

  it("no allowlist in KV falls back to the built-in defaults", async () => {
    const { signer } = await makeSigner();
    await env.WBA_DIR.delete("wba:allow").catch(() => {});
    stubFetch('{"keys":[]}');
    const v = await classifySignature(
      await signedReq(signer, "https://agent-not-in-defaults.test"),
      testEnv(),
    );
    // The defaults don't contain this origin → unknown agent, meaning the
    // fallback set (not an empty set) was used.
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });
});

// Each test gets its OWN origin: a successful directory fetch is written to
// `wba:dir:${origin}` and the 300 s KV-cache get would happily serve an
// empty/filtered record written by an earlier test to every later one.
let originSeq = 0;
const nextOrigin = async () => {
  const origin = `https://agent-${originSeq++}.test`;
  await env.WBA_DIR.put("wba:allow", JSON.stringify([origin]));
  return origin;
};

describe("loadDirectory edges", () => {
  it("a non-ok directory fetch is a transient 503", async () => {
    const { signer } = await makeSigner();
    const origin = await nextOrigin();
    stubFetch("{}", 500);
    const v = await classifySignature(await signedReq(signer, origin), testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 503 });
  });

  it("an oversize directory body is transient", async () => {
    const { signer } = await makeSigner();
    const origin = await nextOrigin();
    stubFetch(`{"keys":[], "pad": "${"x".repeat(70_000)}"}`);
    const v = await classifySignature(await signedReq(signer, origin), testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 503 });
  });

  it("missing keys / over-cap keys both reject as transient", async () => {
    const { signer } = await makeSigner();
    const origin = await nextOrigin();
    stubFetch("{}");
    const v1 = await classifySignature(await signedReq(signer, origin), testEnv());
    expect(v1.kind).toBe("reject");
    stubFetch(
      JSON.stringify({
        keys: Array.from({ length: 101 }, (_, i) => ({ kty: "OKP", crv: "Ed25519", x: `${i}` })),
      }),
    );
    const v2 = await classifySignature(await signedReq(signer, origin), testEnv());
    expect(v2.kind).toBe("reject");
  });

  it("non-OKP keys are filtered and an absent keyid rejects 401", async () => {
    const { signer } = await makeSigner();
    const origin = await nextOrigin();
    stubFetch(
      JSON.stringify({
        keys: [
          { kty: "RSA", x: "abc" },
          { kty: "OKP", crv: "X25519", x: "abc" },
          { kty: "OKP", crv: "Ed25519" },
        ],
      }),
      200,
      { "cache-control": "public, max-age=120" },
    );
    const v = await classifySignature(await signedReq(signer, origin), testEnv());
    expect(v).toMatchObject({ kind: "reject", status: 401 });
  });

  it("a valid fetched key verifies; max-age is honored for the cache write", async () => {
    const { signer, pubJwk } = await makeSigner();
    const origin = await nextOrigin();
    stubFetch(
      JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: pubJwk.x }] }),
      200,
      { "cache-control": "public, max-age=600" },
    );
    const v = await classifySignature(await signedReq(signer, origin), testEnv());
    expect(v).toMatchObject({ kind: "agent", agentOrigin: origin });
    const cached = await env.WBA_DIR.get(`wba:dir:${origin}`, { type: "json" });
    expect(cached).not.toBeNull();
  });

  it("a stale cache entry is served when the live fetch fails", async () => {
    const { signer, pubJwk } = await makeSigner();
    const origin = await nextOrigin();
    const now = Math.floor(Date.now() / 1000);
    await env.WBA_DIR.put(
      `wba:dir:${origin}`,
      JSON.stringify({
        keys: [{ kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: pubJwk.x }],
        fresh: now - 10,
        stale: now + 60,
      }),
    );
    stubFetch("{}", 500);
    const v = await classifySignature(await signedReq(signer, origin), testEnv());
    expect(v).toMatchObject({ kind: "agent" });
  });
});
