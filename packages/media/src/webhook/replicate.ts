// packages/media/src/webhook/replicate.ts — §11.7 verbatim.
// Standard Webhooks: headers webhook-{id,timestamp,signature}; signed payload
// is `${id}.${timestamp}.` + raw body bytes; HMAC-SHA256 key = the whsec_ secret
// with the prefix stripped, base64-decoded. crypto.subtle.verify is
// constant-time, removing the timingSafeEqual the Node version needed.
export async function verifyReplicateWebhook(
  headers: Headers,
  rawBody: ArrayBuffer,
  secretEnv: string,
): Promise<string | null> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const header = headers.get("webhook-signature");
  if (!id || !timestamp || !header || !secretEnv) return null;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return null;

  const raw = Uint8Array.from(atob(secretEnv.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + rawBody.byteLength);
  signed.set(prefix, 0);
  signed.set(new Uint8Array(rawBody), prefix.length); // BYTES; never toString() a video

  for (const part of header.split(" ")) {
    if (!part.startsWith("v1,")) continue;
    const sig = Uint8Array.from(atob(part.slice(3)), (c) => c.charCodeAt(0));
    if (await crypto.subtle.verify("HMAC", key, sig, signed)) return id;
  }
  return null;
}
