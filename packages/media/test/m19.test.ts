// packages/media/test/m19.test.ts — the portable M19 units: schema, keys,
// denylist (gate 2a), idempotency scoping, model picking, and both webhook
// verifiers. Runs under node AND workerd (media-workers project).
import { describe, expect, it } from "vitest";
import {
  assetKey,
  assetUrl,
  generateRequestSchema,
  objectKey,
  pickModel,
  priceFor,
  promptDenylistHit,
  scopeIdempotencyKey,
  sha256Hex,
  sidecarKey,
  stagingKey,
  storageFor,
  thumbnailKey,
  uploadExt,
  verifyReplicateWebhook,
  type MediaModelRow,
  type MediaModelStore,
} from "../src/index.js";

const MODELS: MediaModelRow[] = [
  {
    backend: "fal",
    modelId: "fal-ai/nano-banana-pro",
    kind: "image",
    slot: "default",
    priceAtomic: "40000",
    priceUnit: "per_asset",
    maxDurationS: null,
    preferenceRank: 10,
    enabled: true,
  },
  {
    backend: "fal",
    modelId: "fal-ai/z-image/turbo",
    kind: "image",
    slot: "cheap",
    priceAtomic: "3000",
    priceUnit: "per_asset",
    maxDurationS: null,
    preferenceRank: 30,
    enabled: true,
  },
  {
    backend: "replicate",
    modelId: "owner/model:abc",
    kind: "image",
    slot: "default",
    priceAtomic: "20000",
    priceUnit: "per_asset",
    maxDurationS: null,
    preferenceRank: 50,
    enabled: true,
  },
  {
    backend: "fal",
    modelId: "fal-ai/disabled",
    kind: "image",
    slot: "premium",
    priceAtomic: "999999",
    priceUnit: "per_asset",
    maxDurationS: null,
    preferenceRank: 5,
    enabled: false,
  },
];

const storeOf = (cap: string | null = null): MediaModelStore => ({
  listModels: async (kind) => MODELS.filter((m) => m.kind === kind),
  perActionCapAtomic: async () => cap,
});

const REQ = generateRequestSchema.parse({
  kind: "image",
  prompt: "a river at dusk",
  idempotencyKey: "clientkey-12345678",
  maxCostAtomic: "50000",
});

describe("M19: generateRequestSchema", () => {
  it("accepts the minimal request and defaults aspectRatio+quality", () => {
    const r = generateRequestSchema.parse(REQ);
    expect(r.aspectRatio).toBe("1:1");
    expect(r.quality).toBe("default");
  });
  it("rejects an empty prompt and a foreign reference URL", () => {
    expect(generateRequestSchema.safeParse({ ...REQ, prompt: "" }).success).toBe(false);
    expect(
      generateRequestSchema.safeParse({ ...REQ, referenceImageUrl: "https://evil.example/x.png" })
        .success,
    ).toBe(false);
    expect(
      generateRequestSchema.safeParse({
        ...REQ,
        referenceImageUrl: "https://cdn.musebook.dev/m/a.png",
      }).success,
    ).toBe(true);
  });
});

describe("M19: keys (§11.7.2)", () => {
  const sha = "a".repeat(64);
  it("content-addressed m/p keys + sidecar + thumb", () => {
    expect(assetKey("r2_public", sha, "png")).toBe(`m/${sha}.png`);
    expect(assetKey("r2_paid", sha, "png")).toBe(`p/${sha}.png`);
    expect(objectKey("free", sha, "image/png")).toBe(`m/${sha}.png`);
    expect(objectKey("paid", sha, "image/webp")).toBe(`p/${sha}.webp`);
    expect(sidecarKey(`m/${sha}.png`)).toBe(`m/${sha}.png.c2pa`);
    expect(thumbnailKey(sha, 512)).toBe(`t/${sha}/512.webp`);
    expect(storageFor("paid")).toBe("r2_paid");
    expect(assetUrl("r2_public", `m/${sha}.png`)).toBe(`https://cdn.musebook.dev/m/${sha}.png`);
    expect(assetUrl("r2_paid", `p/${sha}.png`)).toBe(`https://media.musebook.dev/p/${sha}.png`);
    expect(stagingKey("u1", "f1", "a/b/c.png")).toBe("staging/u1/f1/c.png");
  });
});

describe("M19: gate 2a denylist", () => {
  it("blocks csam phrasing and passes a landscape prompt", () => {
    expect(promptDenylistHit("nude photo of an underage girl")).toBe("csam");
    expect(promptDenylistHit("a matte painting of a river at dusk")).toBeNull();
  });
});

describe("M19: idempotency scoping", () => {
  it("scopes by delegation when present, else user:, and is deterministic", async () => {
    const a = await scopeIdempotencyKey("del-1", "u1", "k");
    const b = await scopeIdempotencyKey("del-1", "u1", "k");
    const c = await scopeIdempotencyKey(null, "u1", "k");
    const d = await scopeIdempotencyKey("del-2", "u1", "k");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("M19: pickModel + priceFor", () => {
  it("picks the requested slot, respects caps, excludes a backend", async () => {
    const bound = (n: "fal" | "replicate") => true;
    const m = await pickModel(storeOf(), REQ, { backendBound: bound }, "del-1");
    // §11.4: price ASC then preference_rank — the cheaper default-slot row wins.
    expect(m?.modelId).toBe("owner/model:abc");
    const cheap = await pickModel(
      storeOf(),
      { ...REQ, quality: "cheap" },
      { backendBound: bound },
      "del-1",
    );
    expect(cheap?.modelId).toBe("fal-ai/z-image/turbo");
    const excl = await pickModel(storeOf(), REQ, { backendBound: bound }, "del-1", "fal");
    expect(excl?.backend).toBe("replicate");
    const tight = await pickModel(storeOf("2000"), REQ, { backendBound: bound }, "del-1");
    // per_action_cap 2000 prices out every row → null (no_price_for_model)
    expect(tight).toBeNull();
    expect(priceFor(MODELS[0]!, REQ)).toBe("40000");
  });
});

describe("M19: webhook verifiers", () => {
  it("M19.5 replicate: unsigned and wrong-signature bodies are rejected", async () => {
    const secret = `whsec_${btoa("test-secret-bytes")}`;
    const body = new TextEncoder().encode('{"id":"p1","status":"succeeded"}').buffer;
    expect(await verifyReplicateWebhook(new Headers(), body, secret)).toBeNull();

    // A well-formed but WRONG signature also fails (and does not enqueue).
    const ts = String(Math.floor(Date.now() / 1000));
    const h = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${btoa("wrongsig")}`,
    });
    expect(await verifyReplicateWebhook(h, body, secret)).toBeNull();
  });

  it("M19.5 replicate: a correctly-signed body returns the message id", async () => {
    const rawSecret = "test-secret-bytes";
    const secret = `whsec_${btoa(rawSecret)}`;
    const body = new TextEncoder().encode('{"id":"p1","status":"succeeded"}');
    const ts = String(Math.floor(Date.now() / 1000));
    const id = "msg_42";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(rawSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const prefix = new TextEncoder().encode(`${id}.${ts}.`);
    const signed = new Uint8Array(prefix.length + body.length);
    signed.set(prefix);
    signed.set(body, prefix.length);
    const sig = await crypto.subtle.sign("HMAC", key, signed);
    const h = new Headers({
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`,
    });
    expect(await verifyReplicateWebhook(h, body.buffer as ArrayBuffer, secret)).toBe(id);
  });

  it("M19.5 fal: absent headers are rejected without a JWKS fetch", async () => {
    const { verifyFalWebhook } = await import("../src/webhook/fal.js");
    expect(
      await verifyFalWebhook(new Headers(), new ArrayBuffer(0), "http://127.0.0.1:1/jwks"),
    ).toBeNull();
  });
});

describe("M19: sha256Hex", () => {
  it("hashes to 64 lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
