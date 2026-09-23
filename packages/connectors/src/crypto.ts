// packages/connectors/src/crypto.ts — §10.8.1 semantics on WebCrypto.
// (node:crypto's sync AES-GCM/HKDF does not exist in workerd; the byte layout —
// iv(12) || tag(16) || ciphertext — and the HKDF parameters are unchanged, so
// a ciphertext sealed here opens anywhere the same construction is used.)
const INFO = "musebook-connector-cred";
const te = new TextEncoder();
const u8 = (a: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(a);

async function deriveKey(kek: Uint8Array, delegationId: string): Promise<CryptoKey> {
  // Per-delegation subkey: one stolen ciphertext does not decrypt another delegation's.
  const ikm = await crypto.subtle.importKey("raw", u8(kek), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: u8(te.encode(delegationId)), info: u8(te.encode(INFO)) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealCredential(
  kek: Uint8Array,
  keyId: string,
  delegationId: string,
  plaintext: string,
): Promise<{ ciphertext: Uint8Array; keyId: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(kek, delegationId);
  // WebCrypto appends the 16-byte tag to the ciphertext; the wire layout is
  // iv || tag || body, matching the node:crypto construction byte for byte.
  const ctTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, u8(te.encode(plaintext))),
  );
  const body = ctTag.subarray(0, ctTag.length - 16);
  const tag = ctTag.subarray(ctTag.length - 16);
  const out = new Uint8Array(12 + 16 + body.length);
  out.set(iv, 0);
  out.set(tag, 12);
  out.set(body, 28);
  return { ciphertext: out, keyId };
}

export async function openCredential(
  kek: Uint8Array,
  delegationId: string,
  sealed: Uint8Array,
): Promise<string> {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const body = sealed.subarray(28);
  const ctTag = new Uint8Array(body.length + 16);
  ctTag.set(body, 0);
  ctTag.set(tag, body.length);
  const key = await deriveKey(kek, delegationId);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: u8(iv) }, key, u8(ctTag));
  return new TextDecoder().decode(plain);
}
