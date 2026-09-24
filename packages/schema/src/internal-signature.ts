// packages/schema/src/internal-signature.ts
// node:crypto is fully supported on workerd at compatibility_date 2026-09-21 with
// NO compatibility_flags (CF-SPINE section 12) and natively on Vercel's Node runtime,
// so this one file is byte-identical on both sides of the seam.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

const LABEL = "mb";
const TAG = "musebook-internal";
const COVERED = [
  "@method",
  "@authority",
  "@path",
  "content-digest",
  "mb-timestamp",
  "mb-nonce",
] as const;

export interface SignedHeaders {
  readonly "content-digest": string;
  readonly "mb-timestamp": string;
  readonly "mb-nonce": string;
  readonly "signature-input": string;
  readonly signature: string;
}

function contentDigest(body: string): string {
  return `sha-256=:${createHash("sha256").update(body, "utf8").digest("base64")}:`;
}

function signatureParams(created: number, expires: number, keyId: string): string {
  const items = COVERED.map((c) => `"${c}"`).join(" ");
  return `(${items});created=${created};expires=${expires};keyid="${keyId}";alg="ed25519";tag="${TAG}"`;
}

/** RFC 9421 section 2.5 signature base. Each covered component on its own line,
 *  then "@signature-params". No trailing newline — the classic off-by-one. */
function signatureBase(values: Record<(typeof COVERED)[number], string>, params: string): string {
  const lines = COVERED.map((c) => `"${c}": ${values[c]}`);
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

export function signInternalRequest(args: {
  method: string;
  url: string;
  body: string;
  privateKeyPkcs8B64: string;
  keyId: string;
  ttlSeconds?: number;
  now?: number;
}): SignedHeaders {
  const u = new URL(args.url);
  const created = Math.floor((args.now ?? Date.now()) / 1000);
  const expires = created + (args.ttlSeconds ?? 300);
  const nonce = randomBytes(18).toString("base64url");
  const digest = contentDigest(args.body);

  const params = signatureParams(created, expires, args.keyId);
  const base = signatureBase(
    {
      "@method": args.method.toUpperCase(),
      "@authority": u.host,
      "@path": u.pathname,
      "content-digest": digest,
      "mb-timestamp": String(created),
      "mb-nonce": nonce,
    },
    params,
  );

  const key = createPrivateKey({
    key: Buffer.from(args.privateKeyPkcs8B64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const sig = sign(null, Buffer.from(base, "utf8"), key).toString("base64");

  return {
    "content-digest": digest,
    "mb-timestamp": String(created),
    "mb-nonce": nonce,
    "signature-input": `${LABEL}=${params}`,
    signature: `${LABEL}=:${sig}:`,
  };
}

export type VerifyFailure =
  | "missing_headers"
  | "malformed_signature_input"
  | "unknown_key"
  | "wrong_tag"
  | "expired"
  | "skewed"
  | "digest_mismatch"
  | "bad_signature";

export type VerifyResult =
  | { readonly ok: true; readonly keyId: string; readonly nonce: string; readonly expiresAt: Date }
  | { readonly ok: false; readonly reason: VerifyFailure };

export function verifyInternalRequest(args: {
  method: string;
  url: string;
  body: string;
  headers: Headers;
  publicKeys: Readonly<Record<string, string>>; // keyid -> base64 SPKI
  maxSkewSeconds?: number;
  now?: number;
}): VerifyResult {
  const sigInput = args.headers.get("signature-input");
  const sigHeader = args.headers.get("signature");
  const ts = args.headers.get("mb-timestamp");
  const nonce = args.headers.get("mb-nonce");
  const digestHeader = args.headers.get("content-digest");
  if (
    sigInput === null ||
    sigHeader === null ||
    ts === null ||
    nonce === null ||
    digestHeader === null
  ) {
    return { ok: false, reason: "missing_headers" };
  }

  const paramsMatch = /^mb=(\(.*\);.*)$/.exec(sigInput);
  const sigMatch = /^mb=:([A-Za-z0-9+/=]+):$/.exec(sigHeader);
  const params = paramsMatch?.[1];
  const sig = sigMatch?.[1];
  if (params === undefined || sig === undefined)
    return { ok: false, reason: "malformed_signature_input" };

  const keyId = /keyid="([^"]+)"/.exec(params)?.[1];
  const created = Number(/created=(\d+)/.exec(params)?.[1] ?? NaN);
  const expires = Number(/expires=(\d+)/.exec(params)?.[1] ?? NaN);
  const tag = /tag="([^"]+)"/.exec(params)?.[1];
  if (keyId === undefined || !Number.isFinite(created) || !Number.isFinite(expires)) {
    return { ok: false, reason: "malformed_signature_input" };
  }
  if (tag !== TAG) return { ok: false, reason: "wrong_tag" };

  const spki = args.publicKeys[keyId];
  if (spki === undefined) return { ok: false, reason: "unknown_key" };

  const nowSec = Math.floor((args.now ?? Date.now()) / 1000);
  const skew = args.maxSkewSeconds ?? 300;
  if (nowSec > expires) return { ok: false, reason: "expired" };
  if (Math.abs(nowSec - created) > skew || String(created) !== ts)
    return { ok: false, reason: "skewed" };
  if (contentDigest(args.body) !== digestHeader) return { ok: false, reason: "digest_mismatch" };

  const u = new URL(args.url);
  const base = signatureBase(
    {
      "@method": args.method.toUpperCase(),
      "@authority": u.host,
      "@path": u.pathname,
      "content-digest": digestHeader,
      "mb-timestamp": ts,
      "mb-nonce": nonce,
    },
    params,
  );

  const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
  const ok = verify(null, Buffer.from(base, "utf8"), key, Buffer.from(sig, "base64"));
  if (!ok) return { ok: false, reason: "bad_signature" };

  return { ok: true, keyId, nonce, expiresAt: new Date(expires * 1000) };
}
