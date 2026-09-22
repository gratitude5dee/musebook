// apps/edge/src/auth/web-bot-auth.ts
// RFC 9421 + RFC 9424 verification for the Signature-Agent ladder step (§5.6.1),
// §5.6.2 verbatim. web-bot-auth@0.2.0 — Cloudflare's own, pure WebCrypto, no
// node: imports. The three overrides below are not optional: the library ships
// maxAge 86400 / clockSkew 0 / {ed25519, rsa-pss-sha512}.
import {
  verify,
  HTTP_MESSAGE_SIGNATURES_DIRECTORY, // "/.well-known/http-message-signatures-directory"
  type UntrustedWebBotSignatureCandidate,
  type WebBotVerifier,
} from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import type { IdentityEnv } from "./resolve-actor.js";

export const DIR_TTL_MIN = 300; // 5 min  — floor on the directory's Cache-Control
export const DIR_TTL_MAX = 86_400; // 24 h   — ceiling
export const DIR_TTL_DEFAULT = 3_600; // 1 h    — when the directory sends no Cache-Control
export const DIR_STALE_MAX = 604_800; // 7 d    — how long a stale copy may still be used
export const DIR_MAX_BYTES = 64 * 1024;
export const DIR_MAX_KEYS = 100; // the same cap Cloudflare's reference Worker uses
export const DIR_TIMEOUT_MS = 2_000;

export type AgentVerdict =
  | { kind: "human" } // no Signature header at all
  | { kind: "agent"; keyid: string; agentUri: string; agentOrigin: string }
  | { kind: "reject"; status: 401 | 503; reason: string };

type CachedDir = { keys: JsonWebKey[]; fresh: number; stale: number };

/**
 * A directory read that failed in an upstream way: unreachable, non-2xx,
 * over the 64KB/100-key caps, or unparseable. Distinct from a well-formed
 * directory that simply does not contain the presented keyid — that one is a
 * 401. classifySignature maps this (found anywhere in the error's cause
 * chain, since verify() wraps resolver errors in SignatureError) to 503.
 */
export class DirectoryTransientError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DirectoryTransientError";
    this.cause = cause;
  }
}

/**
 * The SSRF guard, and the single most important security decision in this feature.
 * `resolver` below runs on ATTACKER-CONTROLLED input: web-bot-auth hands the
 * candidate's signatureAgent to the resolver BEFORE the signature is verified, and
 * Cloudflare's own example Worker fetches that URL directly. Without an allowlist
 * the edge is a fetch-amplification primitive.
 *
 * The list lives in KV (key `wba:allow`) rather than in code so a new signing agent
 * is a KV write, not a deploy. Seeded with the four vendors known to sign in
 * Sept 2026; §15 owns the runbook for adding one.
 */
async function allowedOrigins(env: IdentityEnv): Promise<Set<string>> {
  const raw = await env.WBA_DIR.get<string[]>("wba:allow", {
    type: "json",
    cacheTtl: 300,
  });
  return new Set(
    raw ?? [
      "https://chatgpt.com",
      "https://openai.com",
      "https://agent.bot.goog",
      "https://web-bot-auth.cloudflare-browser-rendering-085.workers.dev",
    ],
  );
}

async function loadDirectory(env: IdentityEnv, origin: string): Promise<JsonWebKey[]> {
  const key = `wba:dir:${origin}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = await env.WBA_DIR.get<CachedDir>(key, {
    type: "json",
    cacheTtl: DIR_TTL_MIN,
  });
  if (cached && now < cached.fresh) return cached.keys;

  try {
    const res = await fetch(`${origin}${HTTP_MESSAGE_SIGNATURES_DIRECTORY}`, {
      headers: { accept: "application/http-message-signatures-directory+json" },
      cf: { cacheTtl: DIR_TTL_MIN, cacheEverything: true },
      signal: AbortSignal.timeout(DIR_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`directory ${res.status}`);

    const body = await res.text();
    if (body.length > DIR_MAX_BYTES) throw new Error("directory too large");

    const parsed = JSON.parse(body) as { keys?: unknown };
    if (!Array.isArray(parsed.keys)) throw new Error("directory missing keys");
    if (parsed.keys.length > DIR_MAX_KEYS) throw new Error("too many keys");

    const keys = (parsed.keys as JsonWebKey[]).filter(
      (k) =>
        k &&
        k.kty === "OKP" &&
        (k as { crv?: string }).crv === "Ed25519" &&
        typeof (k as { x?: string }).x === "string",
    );

    const m = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "");
    const ttl = Math.min(DIR_TTL_MAX, Math.max(DIR_TTL_MIN, m ? Number(m[1]) : DIR_TTL_DEFAULT));

    const record: CachedDir = { keys, fresh: now + ttl, stale: now + DIR_STALE_MAX };
    await env.WBA_DIR.put(key, JSON.stringify(record), {
      expirationTtl: DIR_STALE_MAX,
    });
    return keys;
  } catch (e) {
    // Serve stale rather than mis-classify a paying agent as a human.
    if (cached && now < cached.stale) return cached.keys;
    throw new DirectoryTransientError(e);
  }
}

async function resolver(
  env: IdentityEnv,
  c: UntrustedWebBotSignatureCandidate,
): Promise<WebBotVerifier> {
  if (c.signatureAgent === undefined) throw new Error("Signature-Agent required");
  const url = new URL(c.signatureAgent.uri);
  if (url.protocol !== "https:") throw new Error("Signature-Agent must be https");
  if (!(await allowedOrigins(env)).has(url.origin)) {
    throw new Error(`unknown agent ${url.origin}`);
  }
  for (const jwk of await loadDirectory(env, url.origin)) {
    try {
      const v = await verifierFromJWK(jwk);
      if (v.keyid === c.keyid) return v;
    } catch {
      /* skip a malformed key rather than failing the whole directory */
    }
  }
  throw new Error(`unknown keyid ${c.keyid}`);
}

export async function classifySignature(request: Request, env: IdentityEnv): Promise<AgentVerdict> {
  if (request.headers.get("signature") === null) return { kind: "human" };

  try {
    const result = await verify(request, {
      resolver: (c) => resolver(env, c),
      algorithms: ["ed25519"], // the library also accepts rsa-pss-sha512; we do not
      maxAge: 300, // library default is 86400 — far too loose for a paywall
      clockSkew: 30, // library default is 0
    });
    return {
      kind: "agent",
      keyid: result.keyid,
      // The verified Signature-Agent URI itself (the directory URL the agent
      // signs over) — this is the value agent_identities.signature_agent
      // stores, and the raw header (`key1="..."`) is NOT a match for it.
      agentUri: result.signatureAgent!.uri,
      agentOrigin: new URL(result.signatureAgent!.uri).origin,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let transient = false;
    for (let c: unknown = e; c !== null && c !== undefined;) {
      if (c instanceof DirectoryTransientError) {
        transient = true;
        break;
      }
      c = (c as { cause?: unknown }).cause;
    }
    return { kind: "reject", status: transient ? 503 : 401, reason: msg };
  }
}
