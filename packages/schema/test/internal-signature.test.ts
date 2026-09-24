// Roundtrip + tamper vectors for §15.5.3's RFC 9421 internal signature.
// Generate the keypair per run — the private half never lives in the repo.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signInternalRequest, verifyInternalRequest } from "../src/internal-signature";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIV_B64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const PUB_B64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const KEYS = { "key-1": PUB_B64 };
const URL_ = "https://musebook.dev/api/sandbox/render";
const BODY = JSON.stringify({ job: "render", id: "abc" });
const NOW = 1_800_000_000_000;

function signedHeaders(over: Partial<Parameters<typeof signInternalRequest>[0]> = {}) {
  const h = signInternalRequest({
    method: "POST",
    url: URL_,
    body: BODY,
    privateKeyPkcs8B64: PRIV_B64,
    keyId: "key-1",
    now: NOW,
    ...over,
  });
  return new Headers({
    "content-digest": h["content-digest"],
    "mb-timestamp": h["mb-timestamp"],
    "mb-nonce": h["mb-nonce"],
    "signature-input": h["signature-input"],
    signature: h.signature,
  });
}

function verify(headers: Headers, url = URL_, body = BODY, now = NOW + 10_000) {
  return verifyInternalRequest({
    method: "POST",
    url,
    body,
    headers,
    publicKeys: KEYS,
    now,
  });
}

describe("internal-signature", () => {
  it("signs and verifies a request end-to-end", () => {
    const res = verify(signedHeaders());
    expect(res).toMatchObject({ ok: true, keyId: "key-1" });
  });

  it("rejects a body tamper as digest_mismatch", () => {
    expect(verify(signedHeaders(), URL_, '{"job":"render","id":"XYZ"}')).toEqual({
      ok: false,
      reason: "digest_mismatch",
    });
  });

  it("rejects a path tamper as bad_signature", () => {
    expect(verify(signedHeaders(), "https://musebook.dev/api/sandbox/evil")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects an unknown keyid", () => {
    const { privateKey: p2, publicKey: q2 } = generateKeyPairSync("ed25519");
    const h = signedHeaders({
      privateKeyPkcs8B64: p2.export({ format: "der", type: "pkcs8" }).toString("base64"),
      keyId: "key-2",
    });
    expect(
      verifyInternalRequest({
        method: "POST",
        url: URL_,
        body: BODY,
        headers: h,
        publicKeys: { "key-2": q2.export({ format: "der", type: "spki" }).toString("base64") },
        now: NOW + 10_000,
      }),
    ).toMatchObject({ ok: true });
    expect(verify(h)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects expired and skewed signatures", () => {
    expect(verify(signedHeaders(), URL_, BODY, NOW + 400_000)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verify(signedHeaders({ ttlSeconds: 60 }), URL_, BODY, NOW + 400_000)).toEqual({
      ok: false,
      reason: "expired",
    });
    // created far in the future vs the verifier's clock
    expect(verify(signedHeaders({ now: NOW + 400_000 }), URL_, BODY, NOW)).toEqual({
      ok: false,
      reason: "skewed",
    });
  });

  it("rejects missing headers", () => {
    expect(verify(new Headers())).toEqual({ ok: false, reason: "missing_headers" });
  });
});
