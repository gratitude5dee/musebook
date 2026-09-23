// apps/mcp/src/x402/request-state.ts — §7.8's AEAD seal/open for MRTR
// requestState. WebCrypto AES-GCM — no node:crypto — so this file stays
// portable inside workerd's native Ed25519/AES surface. `MCP_REQUEST_STATE_KEY`
// absent ⇒ the MRTR path is disabled outright; there is never an unsealed
// requestState.
export type RequestState = {
  jti: string; // ULID, single-use
  principal: string; // delegation id, or 'anon:' + sha256(client fingerprint)
  postId: string;
  contentHash: string;
  argsDigest: string; // sha256 of canonical JSON of params.arguments
  exp: number; // epoch seconds, now + 600
};

const enc = new TextEncoder();
const dec = new TextDecoder();

async function key(raw: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); // 32 bytes, base64
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(state: RequestState, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await key(secret),
      enc.encode(JSON.stringify(state)),
    ),
  );
  const buf = new Uint8Array(iv.length + ct.length);
  buf.set(iv, 0);
  buf.set(ct, iv.length);
  return `v1.${btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

export async function open(token: string, secret: string): Promise<RequestState | null> {
  if (!token.startsWith("v1.")) return null;
  try {
    const b64 = token.slice(3).replace(/-/g, "+").replace(/_/g, "/");
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.subarray(0, 12) },
      await key(secret),
      buf.subarray(12),
    );
    const state = JSON.parse(dec.decode(pt)) as RequestState;
    return state.exp * 1000 > Date.now() ? state : null;
  } catch {
    return null; // tampered, wrong key, or expired
  }
}
