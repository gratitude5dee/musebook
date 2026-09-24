// packages/artifacts/src/ticket.ts — Ed25519 compact tickets (§11.18).
// crypto.subtle only: runs on workerd with no nodejs_compat, no node:crypto.
export interface TicketClaims {
  readonly a: string;   // artifactId
  readonly v: string;   // version (16 hex)
  readonly ch: string;  // post content_hash — spine invariant 1, the grant's join key
  readonly s: string;   // subject: payer address, or 'user:<uuid>'
  readonly exp: number; // unix seconds; default now + 300
}

const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function mintTicket(key: CryptoKey, claims: TicketClaims): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('Ed25519', key, payload);
  return `${b64u(payload)}.${b64u(sig)}`;
}

export async function verifyTicket(key: CryptoKey, token: string): Promise<TicketClaims | null> {
  const [payloadPart, sigPart] = token.split('.');
  if (!payloadPart || !sigPart) return null;
  const payload = unb64u(payloadPart);
  if (!(await crypto.subtle.verify('Ed25519', key, unb64u(sigPart), payload))) return null;
  let claims: TicketClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(payload)) as TicketClaims;
  } catch {
    return null;
  }
  if (typeof claims.a !== 'string' || typeof claims.v !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.exp * 1000 < Date.now()) return null;
  return claims;
}

/** PEM-armored key helpers for env.* values (§11.18's import-once-per-isolate). */
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function importTicketSigningKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem), 'Ed25519', false, ['sign']);
}

export function importTicketPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', pemToDer(pem), 'Ed25519', false, ['verify']);
}
