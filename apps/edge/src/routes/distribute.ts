// apps/edge/src/routes/distribute.ts — POST /api/distribute (§12.3.7).
// The preview page's Send / Regenerate / Edit / Exclude actions land here, not
// on Vercel: the outbox write and the queue send both need bindings the origin
// lacks. The route writes one job_outbox row (dedupe-keyed — a replay or a
// double-click is a no-op) and fires the fast-path queue send inside
// ctx.waitUntil; the * * * * * sweeper covers the failure case.
import { toConstraint, validateVariant, type VariantCandidate } from "@musebook/distributor";
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { fresh } from "../db/client.js";
import { enqueueJob } from "../enqueue.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

interface DistributeBody {
  action?: unknown;
  postId?: unknown;
  postVersionId?: unknown;
  channelId?: unknown;
  platforms?: unknown;
  body?: unknown;
  threadParts?: unknown;
}

const uuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v
    : null;

/** POST /api/distribute — actor must be the post's author. */
export async function handleDistribute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "human_creator" || actor.userId === null) {
    return json({ error: "forbidden" }, 403);
  }

  const raw = (await request.json().catch(() => null)) as DistributeBody | null;
  const postId = uuid(raw?.postId);
  const postVersionId = uuid(raw?.postVersionId);
  const action = raw?.action;
  if (postId === null || postVersionId === null) {
    return json({ error: "post_id_and_version_required" }, 400);
  }
  const platforms = Array.isArray(raw?.platforms)
    ? raw.platforms.filter((p): p is string => typeof p === "string")
    : [];

  const db = fresh(env);
  try {
    const owned = await db.query<{ ok: boolean }>(
      "select app.can_write_post($1::uuid, $2::uuid) as ok",
      [actor.userId, postId],
    );
    if (owned.rows[0]?.ok !== true) return json({ error: "post_not_found" }, 404);
  } finally {
    await db.end().catch(() => undefined);
  }

  if (action === "send" || action === undefined) {
    // First send / resume-after-preview: the §12.3.3 outbox row, dedupe-keyed
    // on the post_version so a replay is a unique-violation no-op, not a
    // second fan-out.
    const jobId = await enqueueJob(
      env,
      ctx,
      "distribute",
      `distribute:${postVersionId}`,
      {
        stage: "plan",
        postId,
        postVersionId,
        platforms,
        source: "composer",
      },
      actor.userId,
    );
    return json({ status: jobId === null ? "already_queued" : "queued", jobId });
  }

  if (action === "regenerate") {
    const channelId = uuid(raw?.channelId);
    if (channelId === null) return json({ error: "channel_id_required" }, 400);
    // One variant-stage job per click; the channel/platform/schedule fields
    // are resolved inside the consumer from the distribution_jobs row
    // (idempotency_key `dist:{pvid}:{cid}`), because the edge cannot read
    // that table under the noinherit role model.
    const jobKey = `dist:${postVersionId}:${channelId}`;
    const jobId = await enqueueJob(
      env,
      ctx,
      "distribute",
      `distribute-variant:${jobKey}:r${Date.now()}`,
      {
        stage: "variant",
        postId,
        postVersionId,
        channelId,
        jobId: jobKey,
      },
      actor.userId,
    );
    return json({ status: jobId === null ? "already_queued" : "queued", jobId });
  }

  if (action === "exclude") {
    const channelId = uuid(raw?.channelId);
    if (channelId === null) return json({ error: "channel_id_required" }, 400);
    const db = fresh(env);
    try {
      const { rows } = await db.query<{ n: number }>(
        "select app.exclude_distribution_job($1::uuid, $2::uuid) as n",
        [postVersionId, channelId],
      );
      if ((rows[0]?.n ?? 0) === 0) return json({ error: "job_not_excludable" }, 409);
      return json({ status: "excluded" });
    } finally {
      await db.end().catch(() => undefined);
    }
  }

  if (action === "edit") {
    const channelId = uuid(raw?.channelId);
    const body = typeof raw?.body === "string" ? raw.body : null;
    if (channelId === null || body === null) {
      return json({ error: "channel_id_and_body_required" }, 400);
    }
    const threadParts = Array.isArray(raw?.threadParts)
      ? raw.threadParts.filter((p): p is string => typeof p === "string")
      : [];
    return editVariant(env, postId, postVersionId, channelId, body, threadParts);
  }

  return json({ error: "unknown_action" }, 400);
}

/** §12.3.7's Edit: re-run the deterministic validator in the Worker and store
 *  the verdict with generated_by='human'. A failing edit persists
 *  is_valid=false and fails the channel's job — the UI shows it. */
async function editVariant(
  env: Env,
  postId: string,
  postVersionId: string,
  channelId: string,
  body: string,
  threadParts: string[],
): Promise<Response> {
  const db = fresh(env);
  try {
    const { rows: djRows } = await db.query<{ result: Record<string, unknown> | null }>(
      "select app.distribute_job_for($1::uuid, $2::uuid) as result",
      [postVersionId, channelId],
    );
    const dj = djRows[0]?.result;
    if (dj === null || dj === undefined) return json({ error: "job_not_found" }, 404);
    if (dj.state !== "queued") return json({ error: "job_not_editable" }, 409);
    const platform = dj.platform as string;
    const variantId = dj.variant_id as string | null;
    if (variantId === null) return json({ error: "no_variant_yet" }, 404);

    const [{ rows: varRows }, { rows: platRows }, { rows: ovrRows }, { rows: postRows }] =
      await Promise.all([
        db.query<{ result: Record<string, unknown> | null }>(
          "select app.variant_for($1::uuid) as result",
          [variantId],
        ),
        db.query<{ result: Record<string, unknown> | null }>(
          "select app.platform_constraint_for($1) as result",
          [platform],
        ),
        db.query<{ result: Record<string, unknown> | null }>(
          "select app.channel_override_for($1::uuid) as result",
          [channelId],
        ),
        db.query<{ canonical_url: string | null }>(
          "select canonical_url from app.load_resource_by_post_id($1::uuid)",
          [postId],
        ),
      ]);
    const variant = varRows[0]?.result;
    const platformRow = platRows[0]?.result;
    const override = ovrRows[0]?.result ?? null;
    if (
      variant === null ||
      variant === undefined ||
      platformRow === null ||
      platformRow === undefined
    ) {
      return json({ error: "variant_or_platform_missing" }, 404);
    }

    // Best-effort CandidateMedia rebuild: the stored media list is either the
    // validator-era candidates or their mirrored {id,path} counterparts —
    // either way the body/text checks are what a human edit can break.
    const storedMedia = Array.isArray(variant.media)
      ? (variant.media as Record<string, unknown>[])
      : [];
    const media = storedMedia.map((m) => ({
      url: typeof m.url === "string" ? m.url : typeof m.path === "string" ? String(m.path) : "",
      contentType: typeof m.contentType === "string" ? m.contentType : "image/png",
      alt: typeof m.alt === "string" ? m.alt : null,
      widthPx: typeof m.widthPx === "number" ? m.widthPx : null,
      heightPx: typeof m.heightPx === "number" ? m.heightPx : null,
      durationSeconds: typeof m.durationSeconds === "number" ? m.durationSeconds : null,
      thumbnailUrl: null,
    }));
    const candidate: VariantCandidate = {
      body,
      threadParts,
      media,
      title: null,
      canonicalUrl:
        (postRows[0]?.canonical_url as string | null) ?? `https://musebook.dev/p/${postId}`,
    };
    const constraint = toConstraint(platformRow as never, {
      override:
        override === null
          ? null
          : (override as { max_chars: number | null; rules_text: string | null }),
      cdnHost: (env as { CDN_HOST?: string }).CDN_HOST ?? "cdn.musebook.dev",
    });
    const report = validateVariant(candidate, constraint);

    const { rows: saved } = await db.query<{
      result: { variant_id: string; is_valid: boolean } | null;
    }>("select app.save_edited_variant($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb) as result", [
      postVersionId,
      channelId,
      body,
      JSON.stringify(threadParts),
      JSON.stringify(report),
    ]);
    const out = saved[0]?.result;
    if (out === null || out === undefined) return json({ error: "save_failed" }, 500);
    return json({ status: "saved", is_valid: out.is_valid, report });
  } finally {
    await db.end().catch(() => undefined);
  }
}
