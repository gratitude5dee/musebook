// apps/web/test/auth.test.ts — GATE M3 checks 7 & 8.
// lib/auth/thirdweb-auth.ts imports "server-only", which throws under vitest —
// so the test constructs createAuth with the identical options verbatim and the
// same env knob (NEXT_PUBLIC_THIRDWEB_AUTH_DOMAIN) the module reads.
import { describe, expect, it } from "vitest";
import { createAuth, signLoginPayload } from "thirdweb/auth";
import { createThirdwebClient } from "thirdweb";
import { generateAccount } from "thirdweb/wallets";

const DOMAIN = "musebook.dev";

const client = createThirdwebClient({ clientId: "musebook-test" });

const adminAccount = await generateAccount({ client });
const signer = await generateAccount({ client });

const makeAuth = (domain: string) =>
  createAuth({
    domain,
    client,
    adminAccount,
    login: {
      statement: "Sign in to Musebook.",
      uri: "https://musebook.dev",
      version: "1",
      payloadExpirationTimeSeconds: 600,
    },
  });

describe("M3.7 verifyPayload union", () => {
  it("a real signed payload verifies (valid branch carries payload)", async () => {
    const auth = makeAuth(DOMAIN);
    const payload = await auth.generatePayload({ address: signer.address });
    const signed = await signLoginPayload({ payload, account: signer });
    const result = await auth.verifyPayload(signed);
    if (!result.valid) throw new Error(`expected valid, got ${result.error}`);
    expect(result.payload.address.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it("a tampered signature lands on the invalid branch — the caller's verify then never runs", async () => {
    const auth = makeAuth(DOMAIN);
    const payload = await auth.generatePayload({ address: signer.address });
    const signed = await signLoginPayload({ payload, account: signer });
    // Flip one hex character inside the signature.
    const i = signed.signature.length - 5;
    const tampered = (signed.signature.slice(0, i) +
      (signed.signature[i] === "a" ? "b" : "a") +
      signed.signature.slice(i + 1)) as `0x${string}`;
    const result = await auth.verifyPayload({ payload, signature: tampered });
    // The route shape asserts this union branch carries .error and no payload.
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("tampered signature unexpectedly valid");
    expect(typeof result.error).toBe("string");
  });
});

describe("M3.8 domain binding", () => {
  it("a payload minted for example.com fails verifyPayload against musebook.dev", async () => {
    const attackerAuth = makeAuth("example.com");
    const auth = makeAuth(DOMAIN);
    const payload = await attackerAuth.generatePayload({ address: signer.address });
    const signed = await signLoginPayload({ payload, account: signer });
    const result = await auth.verifyPayload(signed);
    expect(result.valid).toBe(false);
  });
});
