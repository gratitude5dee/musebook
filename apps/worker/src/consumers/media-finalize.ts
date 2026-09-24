// apps/worker/src/consumers/media-finalize.ts — §11.7's COLLECT half, claimed
// from a media_finalize outbox row written by the edge webhook (or by the
// */5 poll cron). It re-reads the RESULT from the provider with our own key —
// the webhook body is never trusted — runs safety gates 1 and 3 BEFORE any
// byte reaches R2, round-trips the bytes through the Vercel provenance
// endpoint, writes the content-addressed object plus its .c2pa sidecar, and
// calls finalize_media_job() — the ONLY settlement path (§11.8).
//
// Duplicate deliveries: the conditional UPDATE inside finalize_media_job is
// the lock; on 'already_final' this consumer deletes the R2 objects it just
// wrote under the colliding keys and returns.
import {
  assetUrl,
  backendByName,
  bufferAndHash,
  createBackends,
  deleteKey,
  objectKey,
  screenAssets,
  sidecarKey,
  storageFor,
  putBytes,
  type BackendName,
  type GenerateJobRef,
  type MediaBucketLike,
} from "@musebook/media";
import { signInternalRequest } from "@musebook/schema/internal-signature";
import { audit } from "../lib/audit.js";
import { pgFreshJobs, type DbClient } from "../db.js";
import { mediaModelStore, type MediaJobRow } from "./media.js";

const PROVENANCE_URL = "https://musebook.dev/api/internal/media/provenance";
const PROVENANCE_MAX_BYTES = 25 * 1024 * 1024; // §11.10 — endpoint rejects over 25MB

export function providerUrlsFor(
  backend: string,
  modelId: string,
  providerRequestId: string,
): { statusUrl: string; resultUrl: string; cancelUrl: string } {
  if (backend === "fal") {
    const base = `https://queue.fal.run/${modelId}/requests/${providerRequestId}`;
    return { statusUrl: `${base}/status`, resultUrl: base, cancelUrl: `${base}/cancel` };
  }
  const base = `https://api.replicate.com/v1/predictions/${providerRequestId}`;
  return { statusUrl: base, resultUrl: base, cancelUrl: `${base}/cancel` };
}

interface AuthorContext {
  authorKind: "human" | "agent";
  authorWallet: string;
  authorDisplayName: string;
  connectorSlug: string | null;
  postUrl: string | null;
  paid: boolean;
}

async function loadAuthorContext(db: DbClient, job: MediaJobRow): Promise<AuthorContext> {
  let authorKind: "human" | "agent" = "human";
  let postUrl: string | null = null;
  let paid = false;
  if (job.post_id) {
    const { rows } = await db.query<{
      slug: string | null;
      posted_by_agent_id: string | null;
      price_atomic: string | null;
    }>(
      `select slug, posted_by_agent_id, price_atomic::text
         from public.posts where id = $1`,
      [job.post_id],
    );
    const post = rows[0];
    if (post) {
      authorKind = post.posted_by_agent_id === null ? "human" : "agent";
      postUrl = post.slug ? `https://musebook.dev/p/${post.slug}` : null;
      paid = post.price_atomic !== null && BigInt(post.price_atomic) > 0n;
    }
  }

  let connectorSlug: string | null = null;
  if (job.delegation_id) {
    const { rows } = await db.query<{ slug: string }>(
      `select c.slug from public.delegations d
         join public.connectors c on c.id = d.connector_id
        where d.id = $1`,
      [job.delegation_id],
    );
    connectorSlug = rows[0]?.slug ?? null;
  }

  let authorWallet = "";
  let authorDisplayName = "creator";
  if (job.requested_by_user_id) {
    const { rows: handle } = await db.query<{ handle: string | null }>(
      `select handle from public.profiles where user_id = $1`,
      [job.requested_by_user_id],
    );
    authorDisplayName = handle[0]?.handle ?? "creator";
    // wallets is kernel-plane only (wallets_kernel_read) — the manifest's
    // Person identifier comes from the kernel role, not jobs. Plain `set role`
    // (not app.enter's local): the connection is per-build and ends here.
    await db.query("set role musebook_kernel");
    try {
      const { rows } = await db.query<{ address: string | null }>(
        `select address from public.wallets where user_id = $1 and is_primary limit 1`,
        [job.requested_by_user_id],
      );
      authorWallet = rows[0]?.address ?? "";
    } finally {
      await db.query("set role musebook_jobs");
    }
  }

  return { authorKind, authorWallet, authorDisplayName, connectorSlug, postUrl, paid };
}

interface ProvenanceResponse {
  signedBase64: string | null;
  sidecarBase64: string | null;
  phash: string | null; // 64-char '0'/'1' bit(64) string
  phashFrames: string[] | null;
  thumbnailBase64: string | null; // 512px image thumb or null
  frameBase64s: string[] | null; // video gate-3 frames
  width: number | null;
  height: number | null;
  durationMs: number | null;
  manifestJson: unknown | null;
}

function toB64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function callProvenance(
  env: Env,
  input: {
    bytes: Uint8Array;
    mimeType: string;
    title: string;
    modelId: string;
    backend: string;
    promptSha256: string;
    authorKind: "human" | "agent";
    authorWallet: string;
    authorDisplayName: string;
    connectorSlug: string | null;
    delegationId: string | null;
    postUrl: string | null;
  },
): Promise<ProvenanceResponse> {
  const signingKey = env.MB_INTERNAL_SIGNING_KEY;
  if (signingKey === undefined) throw new Error("MB_INTERNAL_SIGNING_KEY not configured");
  const keyId = env.MB_INTERNAL_KEY_ID;
  if (keyId === undefined || keyId === "") throw new Error("MB_INTERNAL_KEY_ID not configured");

  const body = JSON.stringify({
    bytesB64: toB64(input.bytes),
    mimeType: input.mimeType,
    title: input.title,
    modelId: input.modelId,
    backend: input.backend,
    promptSha256: input.promptSha256,
    authorKind: input.authorKind,
    authorWallet: input.authorWallet,
    authorDisplayName: input.authorDisplayName,
    connectorSlug: input.connectorSlug,
    delegationId: input.delegationId,
    postUrl: input.postUrl,
    // Gate 3 needs thumbnails; the endpoint computes them from the same bytes.
    wantFrames: true,
  });
  const signed = signInternalRequest({
    method: "POST",
    url: PROVENANCE_URL,
    body,
    privateKeyPkcs8B64: signingKey,
    keyId,
  });
  const res = await fetch(PROVENANCE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`provenance_failed: HTTP ${res.status}`);
  return (await res.json()) as ProvenanceResponse;
}

export async function runMediaFinalize(env: Env, mediaJobId: string): Promise<void> {
  const db = await pgFreshJobs(env);
  try {
    const { rows } = await db.query<MediaJobRow>(
      `select * from public.media_jobs where id = $1`,
      [mediaJobId],
    );
    const job = rows[0];
    if (!job) return;
    // Terminal or already-final rows need no work — the outbox dedupe is the
    // first line, this is the second.
    if (job.spend_settled || !["queued", "running"].includes(job.status)) return;
    if (!job.backend || !job.model_id || !job.provider_request_id) {
      await failWith(db, job.id, "missing_provider_handle");
      return;
    }

    const store = mediaModelStore(db);
    const backends = createBackends(env, store);
    const backend = backendByName(backends, job.backend);
    if (!backend) {
      await failWith(db, job.id, "no_backend_for_model");
      return;
    }

    // Step 6's authoritative re-read — the webhook body is never trusted.
    const urls = providerUrlsFor(job.backend, job.model_id, job.provider_request_id);
    const ref: GenerateJobRef = {
      jobId: job.id,
      backend: job.backend as BackendName,
      modelId: job.model_id,
      providerRequestId: job.provider_request_id,
      estimatedCostAtomic: job.estimated_cost_atomic,
      statusUrl: urls.statusUrl,
      cancelUrl: urls.cancelUrl,
      resultUrl: urls.resultUrl,
    };
    const result = await backend.fetchResult(ref);
    if (result.status !== "succeeded" || !result.assets.length) {
      const err = result.status === "failed" ? result.error : "provider_not_finished";
      if (result.status === "failed") await failWith(db, job.id, err.slice(0, 200));
      return; // queued/running — the poll cron will retry
    }
    const remote = result.assets[0]!;

    // Gate 1 — the provider's own flag. It already made the call; do not
    // second-guess it upward (§11.9).
    if (remote.providerNsfw === true) {
      await failWith(db, job.id, "gate1_provider_flag", { gate: 1, categories: ["provider_nsfw"] });
      await audit(env, {
        action: "media.finalize",
        delegation_id: job.delegation_id,
        target_kind: "media_job",
        target_id: job.id,
        after_state: { denied: true, gate: 1 },
      });
      return;
    }

    // Pull the provider bytes once — in memory for the gates and the
    // provenance round-trip, then (only on pass) into R2.
    const mediaRes = await fetch(remote.url, { signal: AbortSignal.timeout(60_000) });
    if (!mediaRes.ok || mediaRes.body === null) {
      await failWith(db, job.id, `asset_fetch_${mediaRes.status}`.slice(0, 200));
      return;
    }
    const { bytes, sha256, byteLength } = await bufferAndHash(mediaRes);
    const contentType = remote.mimeType;

    // Provenance round-trip — the Vercel endpoint signs (when enabled), pHashes
    // and returns thumbnails for gate 3. Over 25MB it returns phash=null and
    // thumbnailBase64=null rather than rejecting, per §11.10's bound.
    const ctx = await loadAuthorContext(db, job);
    const prov = byteLength > PROVENANCE_MAX_BYTES
      ? null // over the endpoint's bound — finalize proceeds without phash/signing
      : await callProvenance(env, {
      bytes,
      mimeType: contentType,
      title: `Musebook media job ${job.id}`,
      modelId: job.model_id,
      backend: job.backend,
      promptSha256: job.prompt_sha256,
      authorKind: ctx.authorKind,
      authorWallet: ctx.authorWallet,
      authorDisplayName: ctx.authorDisplayName,
      connectorSlug: ctx.connectorSlug,
      delegationId: job.delegation_id,
      postUrl: ctx.postUrl,
    }).catch((e) => {
      // The endpoint is best-effort: a provenance outage must not strand a
      // paid generation. phash/signing fields come back null and the finalize
      // proceeds without them (C2PA_SIGNING_ENABLED=false is the default anyway).
      console.warn("provenance_unavailable", (e as Error).message);
      return null;
    });

    // Gate 3 — the vision pass over thumbnails. Blocked bytes are never
    // stored: this runs BEFORE any R2 put (§11.9).
    const frames = (prov?.frameBase64s ?? []).map((b64, i) => ({
      bytes: fromB64(b64),
      mimeType: "image/jpeg",
      label: `frame@${["0%", "50%", "90%"][i] ?? i}`,
    }));
    const thumbnails = prov?.thumbnailBase64
      ? [{ bytes: fromB64(prov.thumbnailBase64), mimeType: "image/jpeg", label: "thumbnail" }]
      : frames;
    if (thumbnails.length) {
      const verdict = await screenAssets(thumbnails, env);
      if (verdict.verdict === "block") {
        await failWith(db, job.id, "gate3_output_screen", {
          gate: 3,
          categories: verdict.categories,
        });
        await audit(env, {
          action: "media.finalize",
          delegation_id: job.delegation_id,
          target_kind: "media_job",
          target_id: job.id,
          after_state: { denied: true, gate: 3, categories: verdict.categories },
        });
        return;
      }
    }

    // Write the signed (or raw) asset + sidecar under content-addressed keys.
    const tier = ctx.paid ? "paid" : "free";
    const storage = storageFor(tier);
    const key = objectKey(tier, sha256, contentType);
    const sideKey = sidecarKey(key);
    const bucket: MediaBucketLike =
      tier === "paid"
        ? (env.PAID_MEDIA as MediaBucketLike)
        : (env.PUBLIC_MEDIA as MediaBucketLike);
    const objectBytes = prov?.signedBase64 ? fromB64(prov.signedBase64) : bytes;
    await putBytes(bucket, key, objectBytes, contentType);
    if (prov?.sidecarBase64) {
      await putBytes(bucket, sideKey, fromB64(prov.sidecarBase64), "application/c2pa");
    }

    // The conditional UPDATE inside finalize_media_job is the settlement lock.
    const { rows: fin } = await db.query<{
      finalized: boolean;
      reason: string;
      asset_id: string | null;
    }>(
      `select * from public.finalize_media_job(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bit(64),$13::bit(64)[],$14)`,
      [
        job.id,
        storage,
        key,
        assetUrl(storage, key),
        contentType,
        byteLength,
        sha256,
        remote.width ?? prov?.width ?? null,
        remote.height ?? prov?.height ?? null,
        remote.durationSeconds !== undefined
          ? Math.round(remote.durationSeconds * 1000)
          : (prov?.durationMs ?? null),
        prov?.sidecarBase64 ? sideKey : null,
        prov?.phash ?? null,
        prov?.phashFrames ?? null,
        job.estimated_cost_atomic,
      ],
    );
    const out = fin[0];
    if (!out?.finalized) {
      // §11.8: another delivery beat us — delete what we just wrote under the
      // colliding keys and ack.
      await deleteKey(bucket, key);
      if (prov?.sidecarBase64) await deleteKey(bucket, sideKey);
      return;
    }

    await audit(env, {
      action: "media.finalize",
      delegation_id: job.delegation_id,
      target_kind: "media_job",
      target_id: job.id,
      after_state: {
        asset_id: out.asset_id,
        bytes: byteLength,
        backend: job.backend,
        model_id: job.model_id,
      },
    });
  } finally {
    await db.end();
  }
}

async function failWith(
  db: DbClient,
  jobId: string,
  reason: string,
  verdict: Record<string, unknown> = {},
): Promise<void> {
  await db.query(`select * from public.fail_media_job($1,$2,$3,($4::text)::jsonb)`, [
    jobId,
    reason.startsWith("gate") ? "blocked_safety" : "failed",
    reason,
    JSON.stringify(verdict),
  ]);
}
