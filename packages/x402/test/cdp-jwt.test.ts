import { beforeAll, describe, expect, it } from "vitest";
import { makeCdpAuthHeaders, signCdpJwt } from "../src/cdp-jwt.js";

// A generated 64-byte base64 Ed25519 blob (CDP's current format: seed ||
// public key), built once from a real keypair so the verify test can check
// the signature against the matching public key.
let ED_B64 = "";
let ED_PUB: CryptoKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const blob = new Uint8Array(64);
  blob.set(pkcs8.subarray(-32)); // the seed is the last 32 bytes of the PKCS8
  blob.set(raw, 32);
  ED_B64 = btoa(String.fromCharCode(...blob));
  ED_PUB = pair.publicKey;
});

const decode = (jwt: string) => {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(h!), (c) => c.charCodeAt(0)))),
    payload: JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(p!), (c) => c.charCodeAt(0))),
    ),
    sig: s,
  };
};

describe("signCdpJwt — Ed25519 (base64 secret)", () => {
  it("emits an EdDSA JWT with CDP's claims", async () => {
    const jwt = await signCdpJwt(
      "kid-1",
      ED_B64,
      "POST api.cdp.coinbase.com/platform/v2/x402/settle",
      1_700_000_000,
    );
    const { header, payload } = decode(jwt);
    expect(header).toMatchObject({ alg: "EdDSA", kid: "kid-1", typ: "JWT" });
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(payload).toMatchObject({
      sub: "kid-1",
      iss: "cdp",
      nbf: 1_700_000_000,
      exp: 1_700_000_120,
      uris: ["POST api.cdp.coinbase.com/platform/v2/x402/settle"],
    });
    expect(jwt.split(".")[2]!.length).toBeGreaterThan(0);
  });

  it("the signature verifies under the matching public key", async () => {
    const jwt = await signCdpJwt(
      "kid-1",
      ED_B64,
      "GET api.cdp.coinbase.com/platform/v2/x402/supported",
      1_700_000_000,
    );
    const [h, p, s] = jwt.split(".");
    const sig = Uint8Array.from(atob(s!.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      ED_PUB,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});

describe("signCdpJwt — ES256 (PEM secret)", () => {
  it("emits an ES256 JWT for a PEM P-256 key", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
    const jwt = await signCdpJwt(
      "kid-2",
      pem,
      "POST api.cdp.coinbase.com/platform/v2/x402/verify",
      1_700_000_000,
    );
    const { header } = decode(jwt);
    expect(header.alg).toBe("ES256");
  });
});

describe("makeCdpAuthHeaders", () => {
  it("signs GET for supported, POST for verify/settle, and Bearer-wraps", async () => {
    const auth = makeCdpAuthHeaders("kid-1", ED_B64);
    for (const [path, method] of [
      ["supported", "GET"],
      ["verify", "POST"],
      ["settle", "POST"],
    ] as const) {
      const { Authorization } = await auth(path);
      expect(Authorization).toMatch(/^Bearer /);
      const { payload } = decode(Authorization.slice(7));
      expect(payload.uris[0]).toBe(`${method} api.cdp.coinbase.com/platform/v2/x402/${path}`);
    }
  });
});
