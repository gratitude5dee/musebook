// apps/edge/src/routes/media.ts — §11.7's media surfaces on the Worker:
//   POST /api/media/generate                  — denylist → submit_media_job → enqueue (ONE round trip)
//   POST /api/media/webhook/{backend}?job=…   — verify → media_finalize outbox → 202
//   GET  /api/media/jobs/{id}                 — owner-scoped status read
//   POST /api/media/jobs/{id}/cancel          — owner cancel → agent_cancel outbox
//   GET  /api/provenance/{assetId}            — the public provenance record (§11.10)
//
// The provider submit never happens here (the request budget); musebook-media
// owns it. The safety gates that cost tokens (2b, 3) live on the worker where
// AI_GATEWAY_API_KEY is bound — the edge runs only the deterministic 2a list.
import {
  generateRequestSchema,
  pickModel,
  priceFor,
  promptDenylistHit,
  scopeIdempotencyKey,
  sha256Hex,
  webhookVerifier,
  type BackendName,
  type MediaModelStore,
} from "@musebook/media";
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { enqueueJob } from "../enqueue.js";
import { fresh } from "../db/client.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** media_models + the delegation cap, read under the worker login. */
export function edgeMediaModelStore(db: ReturnType<typeof fresh>): MediaModelStore {
  return {
    async listModels(kind) {
      const { rows } = await db.query<{
        backend: BackendName;
        model_id: string;
        kind: string;
        slot: string;
        price_atomic: string | null;
        price_unit: string;
        max_duration_s: number | null;
        preference_rank: number;
        enabled: boolean;
      }>(
        `select backend, model_id, kind, slot, price_atomic::text, price_unit,
                max_duration_s, preference_rank, enabled
           from public.media_models where kind = $1`,
        [kind],
      );
      return rows.map((r) => ({
        backend: r.backend,
        modelId: r.model_id,
        kind: r.kind as "image" | "video",
        slot: r.slot,
        priceAtomic: r.price_atomic,
        priceUnit: r.price_unit as "per_asset" | "per_second",
        maxDurationS: r.max_duration_s,
        preferenceRank: r.preference_rank,
        enabled: r.enabled,
      }));
    },
    async perActionCapAtomic(delegationId) {
      if (!delegationId) return null;
      const { rows } = await db.query<{ v: string | null }>(
        `select per_action_cap_atomic::text as v from public.delegations where id = $1::uuid`,
        [delegationId],
      );
      return rows[0]?.v ?? null;
    },
  };
}

// ------------------------------------------------------------- POST /generate
export async function handleMediaGenerate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.userId === null) return json({ error: "auth_required" }, 401);
  if (actor.class === "owner_agent" && !actor.scopes.includes("media:generate")) {
    return json({ error: "insufficient_scope" }, 403);
  }
  // delegationId only exists on the agent class; a human submitter is null.
  const delegationId = actor.class === "owner_agent" ? actor.delegationId : null;

  const raw = (await request.json().catch(() => null)) as unknown;
  const parsed = generateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: "invalid_request", issues: parsed.error.issues.map((i) => i.message) }, 400);
  }
  const req = parsed.data;

  // Gate 2a — the deterministic denylist. Free; a hit never writes a row.
  const deniedCategory = promptDenylistHit(req.prompt);
  if (deniedCategory !== null) {
    return json({ error: "denied", reason: deniedCategory }, 403);
  }

  const scopedKey = scopeIdempotencyKey(delegationId, actor.userId, req.idempotencyKey);
  const promptSha256 = await sha256Hex(req.prompt);

  const db = fresh(env);
  try {
    const store = edgeMediaModelStore(db);
    // Model pick happens where the catalogue is — §11.4's picker runs on the
    // edge so the estimate is honest before submit_media_job takes the hold.
    // Provider-bound state comes from which API keys this deploy has.
    const bound = (n: BackendName) =>
      n === "fal" ? true : env.MEDIA_BACKEND_REPLICATE_ENABLED === "true";
    const model = await pickModel(store, req, { backendBound: bound }, delegationId);
    if (model === null) return json({ error: "no_price_for_model" }, 404);
    const estimate = priceFor(model, req);
    if (estimate === null) return json({ error: "no_price_for_model" }, 404);

    const { rows } = await db.query<{
      allowed: boolean;
      reason: string;
      media_job_id: string | null;
      job_id: number | null;
      reservation_id: string | null;
    }>(
      `select * from public.submit_media_job($1,$2,$3,$4,$5,$6,$7,$8,($9::text)::jsonb)`,
      [
        delegationId,
        actor.userId,
        req.kind,
        model.modelId,
        req.prompt,
        promptSha256,
        estimate,
        scopedKey,
        JSON.stringify({
          aspectRatio: req.aspectRatio,
          quality: req.quality,
          maxCostAtomic: req.maxCostAtomic,
          ...(req.negativePrompt !== undefined ? { negativePrompt: req.negativePrompt } : {}),
          ...(req.durationSeconds !== undefined ? { durationSeconds: req.durationSeconds } : {}),
          ...(req.referenceImageUrl !== undefined
            ? { referenceImageUrl: req.referenceImageUrl }
            : {}),
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
        }),
      ],
    );
    const r = rows[0];
    if (!r) throw new Error("submit_media_job returned no row");

    if (!r.allowed) {
      const status =
        r.reason === "pending_approval"
          ? 202
          : r.reason === "spend_cap_exceeded" || r.reason === "per_action_cap"
            ? 402
            : r.reason === "generation_rate"
              ? 429
              : 403;
      return json({ error: r.reason, media_job_id: r.media_job_id }, status);
    }
    if (r.reason === "replay") {
      return json({ media_job_id: r.media_job_id, replay: true }, 200);
    }

    // ONE queue send inside waitUntil — the outbox row is the record (§11.7).
    // postgres.js hands int8 back as a string; dispatch's jobIdOf reads numbers.
    if (r.job_id !== null && env.Q_MEDIA !== undefined) {
      ctx.waitUntil(env.Q_MEDIA.send(JSON.stringify({ job_id: Number(r.job_id), kind: "media" })));
    }
    return json(
      { media_job_id: r.media_job_id, job_id: r.job_id, reservation_id: r.reservation_id },
      202,
    );
  } finally {
    await db.end().catch(() => undefined);
  }
}

// ------------------------------------------------------ POST /webhook/{name}
export async function handleMediaWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  backend: string,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (backend !== "fal" && backend !== "replicate") {
    return new Response("unknown backend", { status: 404 });
  }

  const rawBody = await request.arrayBuffer();
  const verify = webhookVerifier(backend, env);
  // Missing verifier config = misconfigured deploy; 401 like an unsigned body
  // (the webhook stays useless until the var exists, which is the point).
  if (verify === null) return new Response("unauthorized", { status: 401 });
  const requestId = await verify(request.headers, rawBody);
  if (requestId === null) return new Response("unauthorized", { status: 401 });

  const mediaJobId = new URL(request.url).searchParams.get("job");
  if (mediaJobId === null || !UUID_RE.test(mediaJobId)) {
    return new Response("missing job", { status: 400 });
  }

  // The webhook body is NEVER read for content — only requestId for logging.
  // The outbox row's dedupe_key is the media_jobs id: ten retried deliveries
  // produce one row, hence one finalize run (§11.8).
  const db = fresh(env);
  try {
    const { rows } = await db.query<{ id: string | null }>(
      // ($2::text)::jsonb — see enqueue.ts; a bare ::jsonb bind of a
      // JSON.stringify'ed payload lands as a jsonb scalar under postgres.js.
      "select app.enqueue_job('media_finalize', $1, ($2::text)::jsonb, null) as id",
      [mediaJobId, JSON.stringify({ media_job_id: mediaJobId, provider: backend })],
    );
    const jobId = rows[0]?.id;
    if (jobId !== null && jobId !== undefined) {
      if (env.Q_MEDIA_FINALIZE !== undefined) {
        ctx.waitUntil(env.Q_MEDIA_FINALIZE.send(JSON.stringify({ job_id: Number(jobId) })));
      }
      // first-seen bookkeeping; retries do not bump webhook_delivery_count —
      // the finalize conditional UPDATE does, once, on success.
      await db.query(
        `update public.media_jobs set webhook_first_seen_at = coalesce(webhook_first_seen_at, now())
          where id = $1::uuid`,
        [mediaJobId],
      ).catch(() => undefined);
    }
    return new Response(null, { status: 202 });
  } finally {
    await db.end().catch(() => undefined);
  }
}

// --------------------------------------------------------- GET /jobs/{id}
export async function handleMediaJobGet(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  jobId: string,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.userId === null) return json({ error: "auth_required" }, 401);
  if (!UUID_RE.test(jobId)) return json({ error: "not_found" }, 404);

  const db = fresh(env);
  try {
    const { rows } = await db.query<{ j: Record<string, unknown> }>(
      `select to_jsonb(j) as j from public.media_jobs j
        where j.id = $1::uuid
          and (j.requested_by_user_id = $2::uuid
               or j.delegation_id in (
                    select d.id from public.delegations d
                     where d.owner_user_id = $2::uuid))`,
      [jobId, actor.userId],
    );
    const job = rows[0]?.j;
    if (job === undefined) return json({ error: "not_found" }, 404);
    return json({ job });
  } finally {
    await db.end().catch(() => undefined);
  }
}

export async function handleMediaJobCancel(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  jobId: string,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.userId === null) return json({ error: "auth_required" }, 401);
  if (!UUID_RE.test(jobId)) return json({ error: "not_found" }, 404);

  const db = fresh(env);
  try {
    const { rows } = await db.query<{ id: string; status: string }>(
      `select j.id, j.status from public.media_jobs j
        where j.id = $1::uuid
          and (j.requested_by_user_id = $2::uuid
               or j.delegation_id in (
                    select d.id from public.delegations d
                     where d.owner_user_id = $2::uuid))`,
      [jobId, actor.userId],
    );
    const job = rows[0];
    if (job === undefined) return json({ error: "not_found" }, 404);
    // Agent-cancel handles the cooperative provider cancel + the release.
    if (["queued", "pending_approval", "running"].includes(job.status)) {
      await enqueueJob(
        env,
        ctx,
        "agent_cancel",
        `media_cancel:${job.id}`,
        { external_kind: "media_job", external_ref: job.id },
        actor.userId,
      );
    }
    return json({ media_job_id: job.id, status: job.status }, 202);
  } finally {
    await db.end().catch(() => undefined);
  }
}

// ------------------------------------------------- GET /provenance/{assetId}
/** §11.10's public provenance read — the soft binding plus the c2pa block
 *  carried in assets.c2pa_manifest. `url`/`sidecarUrl` stay off the response
 *  for paid assets unless the caller resolves access (reads are anonymous —
 *  the resolveAccess check is the kernel path, not this route's job). */
export async function handleProvenanceGet(
  request: Request,
  env: Env,
  assetId: string,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if (!UUID_RE.test(assetId)) return json({ error: "not_found" }, 404);

  const db = fresh(env);
  try {
    const { rows } = await db.query<{
      id: string;
      storage: string;
      object_key: string;
      c2pa_sidecar_key: string | null;
      c2pa_signed_at: string | null;
      c2pa_manifest: unknown;
      phash: string | null;
      phash_frames: string[] | null;
      generator: string | null;
      source_kind: string;
      owner_user_id: string;
    }>(
      `select a.id, a.storage, a.object_key, a.c2pa_sidecar_key, a.c2pa_signed_at,
              a.c2pa_manifest, a.phash::text as phash, a.phash_frames::text[] as phash_frames,
              a.generator, a.source_kind, a.owner_user_id
         from public.assets a where a.id = $1::uuid and a.deleted_at is null`,
      [assetId],
    );
    const a = rows[0];
    if (a === undefined) return json({ error: "not_found" }, 404);

    const isPaid = a.storage === "r2_paid";
    const body: Record<string, unknown> = {
      assetId: a.id,
      sourceKind: a.source_kind,
      generator: a.generator,
      softBinding:
        a.phash !== null
          ? { algorithm: "phash-64dct", value: a.phash, frames: a.phash_frames }
          : null,
      c2pa: {
        signedAt: a.c2pa_signed_at,
        manifest: a.c2pa_manifest,
      },
    };
    if (!isPaid) {
      body.url = `https://cdn.musebook.dev/${a.object_key}`;
      body.sidecarUrl = a.c2pa_sidecar_key
        ? `https://cdn.musebook.dev/${a.c2pa_sidecar_key}`
        : null;
    }
    return new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600, immutable",
      },
    });
  } finally {
    await db.end().catch(() => undefined);
  }
}
