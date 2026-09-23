// packages/connectors/test/sign.test.ts — §10.8.4's outbound signature: the
// Ed25519 Signature params the plan fixes (alg, tag, 60s expiry, @authority +
// signature-agent covered) and a sign->verify round-trip against the same
// web-bot-auth verify() musebook-edge runs on the way in.
import { describe, expect, it } from "vitest";
import { verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { signOutbound, SIGNATURE_AGENT_ENTRY } from "../src/sign.js";
import type { JsonWebKey } from "../src/types.js";

const URL_ = new URL("https://example.com/agent/draft");

async function keypair(): Promise<{ priv: JsonWebKey; pub: JsonWebKey }> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const priv = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  priv.kid = pub.kid = "m9-test-key";
  priv.alg = pub.alg = "EdDSA"; // node exports "Ed25519"; web-bot-auth wants EdDSA
  return { priv, pub };
}

async function roundTrip(init: RequestInit, pub: JsonWebKey) {
  const request = new Request(URL_, init);
  return verify(request, {
    resolver: async () => verifierFromJWK(pub),
    algorithms: ["ed25519"],
    maxAge: 300,
    clockSkew: 30,
  });
}

describe("§10.8.4 — signOutbound", () => {
  it("returns init with signature, signature-input and signature-agent headers", async () => {
    const { priv } = await keypair();
    const out = await signOutbound(URL_, { method: "post" }, priv);
    const headers = new Headers(out.headers);
    expect(out.method).toBe("POST"); // method normalised to upper-case
    expect(headers.get("signature")).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);
    const input = headers.get("signature-input") ?? "";
    expect(input).toContain('alg="ed25519"');
    expect(input).toContain('tag="web-bot-auth"');
    expect(input).toContain('"@authority"');
    expect(input).toContain('"signature-agent"');
    expect(input).toContain("created=");
    expect(input).toContain("expires=");
    expect(input).toContain("nonce=");
    expect(input).toMatch(/keyid="[A-Za-z0-9_-]+"/);
    expect(headers.get("signature-agent")).toBe(SIGNATURE_AGENT_ENTRY);
  });

  it("expires exactly 60s after created", async () => {
    const { priv } = await keypair();
    const out = await signOutbound(URL_, {}, priv);
    const input = new Headers(out.headers).get("signature-input") ?? "";
    const created = Number(/created=(\d+)/.exec(input)?.[1]);
    const expires = Number(/expires=(\d+)/.exec(input)?.[1]);
    expect(expires - created).toBe(60);
  });

  it("signs a request edge's verify() accepts, preserving existing headers and init", async () => {
    const { priv, pub } = await keypair();
    const out = await signOutbound(
      URL_,
      { method: "POST", headers: { "x-agent": "m9" }, keepalive: true },
      priv,
    );
    expect((out.headers as Headers).get("x-agent")).toBe("m9");
    expect(out.keepalive).toBe(true);
    const result = await roundTrip(out, pub);
    const signedKeyid = /keyid="([A-Za-z0-9_-]+)"/.exec(
      (out.headers as Headers).get("signature-input") ?? "",
    )?.[1];
    expect(result.keyid).toBe(signedKeyid);
    expect(result.signatureAgent?.uri).toBe(
      "https://musebook.dev/.well-known/http-message-signatures-directory",
    );
  });

  it("a tampered covered component fails verification", async () => {
    const { priv, pub } = await keypair();
    const out = await signOutbound(URL_, {}, priv);
    const headers = new Headers(out.headers);
    headers.set("signature-agent", 'musebook="https://evil.example/dir";type=directory');
    await expect(roundTrip({ ...out, headers }, pub)).rejects.toThrow();
  });
});
