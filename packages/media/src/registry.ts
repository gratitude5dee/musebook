// packages/media/src/registry.ts — §11.4 backend pick + §11.8 scoped keys.
// media_models is DATA (spine invariant 5): every price and endpoint id is a
// row read per request, never a literal in the bundle.
import type { BackendName, GenerateRequest, MediaBackend, MediaKind } from "./backend";
import { createFalBackend } from "./fal";
import { createReplicateBackend } from "./replicate";
import { verifyFalWebhook } from "./webhook/fal";
import { verifyReplicateWebhook } from "./webhook/replicate";

export interface MediaModelRow {
  readonly backend: BackendName;
  readonly modelId: string;
  readonly kind: MediaKind;
  readonly slot: string; // 'default'|'fast'|'cheap'|'premium'|'i2v'
  readonly priceAtomic: string | null; // null = disabled: reject, never free
  readonly priceUnit: "per_asset" | "per_second";
  readonly maxDurationS: number | null;
  readonly preferenceRank: number;
  readonly enabled: boolean;
}

/**
 * The persistence port. Implemented by the edge route (worker role, HYPERDRIVE
 * FRESH) and by the media consumer (jobs plane) — the package stays DB-agnostic.
 */
export interface MediaModelStore {
  listModels(kind: MediaKind): Promise<readonly MediaModelRow[]>;
  /** delegation.per_action_cap_atomic; null delegation → null (no second cap). */
  perActionCapAtomic(delegationId: string | null): Promise<string | null>;
}

/** §11.5 — a model with no price row is rejected; never default to zero. */
export function priceFor(model: MediaModelRow, req: GenerateRequest): string | null {
  if (model.priceAtomic === null) return null;
  const price = BigInt(model.priceAtomic);
  if (model.priceUnit === "per_asset") return price.toString();
  const seconds = BigInt(req.durationSeconds ?? 5);
  return (price * seconds).toString();
}

export interface PickContext {
  /** Which provider secrets are bound — a missing FAL_KEY disables fal. */
  backendBound(name: BackendName): boolean;
}

/**
 * §11.4 steps 1–3: kind + enabled + secret bound, price ≤ maxCostAtomic and ≤
 * the delegation's per-action cap, prefer the requested quality slot, tie-break
 * lowest price then preference_rank.
 */
export async function pickModel(
  store: MediaModelStore,
  req: GenerateRequest,
  ctx: PickContext,
  delegationId: string | null,
  excludeBackend?: BackendName,
): Promise<MediaModelRow | null> {
  const cap = await store.perActionCapAtomic(delegationId);
  const ceiling =
    cap === null ? BigInt(req.maxCostAtomic) : minBig(BigInt(req.maxCostAtomic), BigInt(cap));
  const rows = (await store.listModels(req.kind)).filter(
    (r) =>
      r.enabled &&
      ctx.backendBound(r.backend) &&
      r.backend !== excludeBackend &&
      r.priceAtomic !== null &&
      BigInt(priceFor(r, req)!) <= ceiling,
  );
  if (!rows.length) return null;
  const slotted = rows.filter((r) => r.slot === req.quality);
  const pool = slotted.length ? slotted : rows;
  return pool.sort(
    (a, b) =>
      cmpBig(BigInt(priceFor(a, req)!), BigInt(priceFor(b, req)!)) ||
      a.preferenceRank - b.preferenceRank,
  )[0]!;
}

/** §11.4's per-request backend pick — a backend whose secret is bound. */
export function createBackends(
  env: { FAL_KEY?: string; REPLICATE_API_TOKEN?: string },
  store: MediaModelStore,
): readonly MediaBackend[] {
  const out: MediaBackend[] = [];
  if (env.FAL_KEY) out.push(createFalBackend(env.FAL_KEY, store));
  if (env.REPLICATE_API_TOKEN) out.push(createReplicateBackend(env.REPLICATE_API_TOKEN, store));
  return out;
}

export function backendByName(
  backends: readonly MediaBackend[],
  name: string,
): MediaBackend | null {
  return backends.find((b) => b.name === name) ?? null;
}

/**
 * Edge-side verifier factory — the webhook route needs only verifyWebhook, and
 * verify needs the JWKS URL / webhook secret, not the provider API keys.
 * MEDIA_WEBHOOK_VERIFY_MODE='log' is handled by the caller.
 */
export function webhookVerifier(
  name: string,
  env: { FAL_WEBHOOK_JWKS_URL?: string; REPLICATE_WEBHOOK_SECRET?: string },
): ((headers: Headers, rawBody: ArrayBuffer) => Promise<string | null>) | null {
  if (name === "fal") {
    const jwks = env.FAL_WEBHOOK_JWKS_URL;
    if (!jwks) return null;
    return (h, b) => verifyFalWebhook(h, b, jwks);
  }
  if (name === "replicate") {
    const secret = env.REPLICATE_WEBHOOK_SECRET;
    if (!secret) return null;
    return (h, b) => verifyReplicateWebhook(h, b, secret);
  }
  return null;
}

/** §11.8 — runs on workerd, so WebCrypto, not node:crypto. */
export async function scopeIdempotencyKey(
  delegationId: string | null,
  userId: string,
  clientKey: string,
): Promise<string> {
  const principal = delegationId ?? `user:${userId}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${principal}:${clientKey}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
