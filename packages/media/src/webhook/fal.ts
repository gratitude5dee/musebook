// packages/media/src/webhook/fal.ts — §11.7 verbatim.
// Deliveries carry X-Fal-Webhook-{Request-Id, User-Id, Timestamp, Signature}.
// Ed25519 over `requestId\nuserId\ntimestamp\nsha256hex(rawBody)`; keys are
// OKP JWKs from the JWKS URL, module-cached for 24h with one force-refetch.
// UNVERIFIED (spec): the byte layout could not be confirmed against fal's docs
// — run MEDIA_WEBHOOK_VERIFY_MODE=log until a real delivery is observed.
const MAX_SKEW_SECONDS = 300;
let cache: { keys: CryptoKey[]; fetchedAt: number } | null = null;

async function falPublicKeys(jwksUrl: string, force = false): Promise<CryptoKey[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < 86_400_000) return cache.keys;
  const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`fal jwks ${res.status}`);
  const jwks = (await res.json()) as { keys: { x: string }[] };
  const keys = await Promise.all(
    jwks.keys.map((k) =>
      crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: "Ed25519", x: k.x },
        { name: "Ed25519" },
        false,
        ["verify"],
      ),
    ),
  );
  cache = { keys, fetchedAt: Date.now() };
  return keys;
}

export function resetFalJwksCacheForTest(): void {
  cache = null;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyFalWebhook(
  headers: Headers,
  rawBody: ArrayBuffer,
  jwksUrl: string,
): Promise<string | null> {
  const requestId = headers.get("x-fal-webhook-request-id");
  const userId = headers.get("x-fal-webhook-user-id");
  const timestamp = headers.get("x-fal-webhook-timestamp");
  const signatureHex = headers.get("x-fal-webhook-signature");
  if (!requestId || !userId || !timestamp || !signatureHex) return null;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return null;

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody));
  const bodyHashHex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  const message = new TextEncoder().encode([requestId, userId, timestamp, bodyHashHex].join("\n"));

  const sig = hexToBytes(signatureHex);
  if (!sig) return null;

  for (const force of [false, true]) {
    const keys = await falPublicKeys(jwksUrl, force);
    for (const key of keys) {
      if (await crypto.subtle.verify("Ed25519", key, sig, message)) return requestId;
    }
  }
  return null;
}
