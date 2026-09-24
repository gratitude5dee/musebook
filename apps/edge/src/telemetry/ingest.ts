// apps/edge/src/telemetry/ingest.ts — §13.4.4, the six steps verbatim, with the
// one §4.9-shaped adaptation: the M11 facet columns (anon_id, view_session_id,
// content_hash, outcome, max_scroll_pct, completion_pct) do not exist on
// action_events until 20260922092000_telemetry_facets.sql, so they ride inside
// `client` until M11 (the writer omits the columns — plan §6.15's own rule).
// Anonymous human batches are DROPPED at M6, not stored: action_events_
// plane_purity has no anon_id arm yet and a row satisfying neither arm is a
// constraint violation anyway.
import { DIRECT_FETCH_SLATE_ID } from "@musebook/schema";
import { inLabelSample } from "@musebook/telemetry";
import type { HumanBatch } from "@musebook/schema/telemetry";
import { writePoint } from "@musebook/telemetry";
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { bound, fresh, type DbClient } from "../db/client.js";

export interface IngestMeta {
  request: Request;
  optedOut: boolean;
  ipHash: string | null;
  requestId: string | null;
  country: string;
}

interface SlateVersion {
  slate_id: string;
  weights_version: string;
  model_version: string;
}

// Slates are immutable; the isolate memo is correct without invalidation.
const slateMemo = new Map<string, SlateVersion | null>();

async function resolveSlateVersions(
  db: DbClient,
  ids: string[],
): Promise<Map<string, SlateVersion>> {
  const missing = ids.filter((id) => !slateMemo.has(id));
  if (missing.length > 0) {
    const { rows } = await db.query<{
      id: string;
      weights_version: string;
      model_version: string;
    }>("select * from app.resolve_slate_versions($1::uuid[])", [missing]);
    for (const id of missing) slateMemo.set(id, null);
    for (const r of rows)
      slateMemo.set(r.id, {
        slate_id: r.id,
        weights_version: r.weights_version,
        model_version: r.model_version,
      });
  }
  const out = new Map<string, SlateVersion>();
  for (const id of ids) {
    const v = slateMemo.get(id);
    if (v !== null && v !== undefined) out.set(id, v);
  }
  return out;
}

export async function ingestHumanBatch(
  env: Env,
  ctx: ExecutionContext,
  batch: HumanBatch,
  meta: IngestMeta,
): Promise<void> {
  if (String(env.TELEMETRY_ENABLED) === "false") return;
  const db = fresh(env);
  // end() must not run at binding time — ctx.waitUntil(db.end()) evaluates it
  // NOW and every query below dies CONNECTION_ENDED. The owner's finally runs
  // it after the batch lands.
  try {
    await ingestBatch(db, env, ctx, batch, meta);
  } finally {
    await db.end().catch(() => undefined);
  }
}

async function ingestBatch(
  db: DbClient,
  env: Env,
  ctx: ExecutionContext,
  batch: HumanBatch,
  meta: IngestMeta,
): Promise<void> {
  // Step 1 — the subject. The same resolver the gate uses. M6: an anonymous
  // batch cannot satisfy either arm of action_events_plane_purity (anon_id is
  // an M11 facet), so there is nothing to mint: it is dropped here rather than
  // rejected by the constraint (§13.4.4's own drop rule).
  // A presented-but-bad credential rejects the whole batch — no subject can be
  // minted for it and telemetry never gets a 401 to report.
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, meta.request);
  if (actor instanceof Response) return;
  const viewerUserId = actor.plane === "human" ? actor.userId : null;

  const skewMax = Number(env.TELEMETRY_CLOCK_SKEW_MAX_MS ?? 21_600_000);
  const sampleRate = Math.min(Math.max(Number(env.TELEMETRY_IMPRESSION_SAMPLE ?? 1), 0), 1);
  let referrerHost: string | null = null;
  try {
    const r = meta.request.headers.get("referer");
    referrerHost = r === null ? null : new URL(r).host;
  } catch {
    referrerHost = null;
  }

  if (meta.optedOut) {
    // §13.9.1 — no behavioural record in EITHER store; the bare counter keeps
    // the creator's headline honest. One statement per distinct post_id.
    const impressions = new Set<string>();
    const opens = new Set<string>();
    for (const e of batch.events) {
      if (e.action === "impression") impressions.add(e.post_id);
      if (e.action === "view") opens.add(e.post_id);
    }
    for (const postId of impressions) {
      await db.query("select app.adjust_counter($1::uuid, 'impressions', 1, $2::uuid)", [
        postId,
        viewerUserId,
      ]);
    }
    for (const postId of opens) {
      await db.query("select app.adjust_counter($1::uuid, 'opens', 1, $2::uuid)", [
        postId,
        viewerUserId,
      ]);
    }
    return;
  }

  // Step 2 — slate versions server-side, on FRESH (a cached negative lookup
  // rewrites every event in the window to 'none' and poisons the training set).
  const resolved = await resolveSlateVersions(
    db,
    batch.events.map((e) => e.slate_id),
  );

  // Step 5 — AE first, unconditionally per event. The only writer in the repo.
  for (const e of batch.events) {
    const v = resolved.get(e.slate_id) ?? {
      slate_id: DIRECT_FETCH_SLATE_ID,
      weights_version: "none",
      model_version: "reverse_chron",
    };
    writePoint(bound(env.TELEMETRY, "TELEMETRY"), {
      postId: e.post_id,
      action: e.action,
      plane: "human",
      surface: e.surface,
      slateId: v.slate_id,
      weightsVersion: v.weights_version,
      modelVersion: v.model_version,
      outcome: "ok",
      contentHash: e.content_hash,
      routeClass: e.surface === "post" ? "page" : "feed",
      requestId: meta.requestId ?? "",
      release: env.MB_RELEASE_SHA,
      position: e.position,
      dwellMs: e.dwell_ms ?? 0,
      sampleRate, // double3. Never omitted; there is no default.
      maxScrollPct: e.max_scroll_pct ?? 0,
      completionPct: e.completion_pct ?? 0,
      n: 1,
    });
  }

  if (viewerUserId === null) return; // anonymous: AE only (see step 1)

  // Step 6 — the label sample, then one statement per batch.
  const labelled = batch.events.filter((e) => inLabelSample(e.view_session_id, sampleRate));
  if (labelled.length === 0) return;

  const now = Date.now();
  const rows = labelled.map((e) => {
    const v = resolved.get(e.slate_id) ?? {
      slate_id: DIRECT_FETCH_SLATE_ID,
      weights_version: "none",
      model_version: "reverse_chron",
    };
    const t = new Date(Math.min(Math.max(e.t, now - skewMax), now + 120_000));
    const skewMs = e.t - now;
    const client = {
      viewport: e.viewport ?? null,
      skew_ms: skewMs,
      sample_rate: sampleRate,
      referrer_host: referrerHost,
      media: e.media ?? null,
      // M11 facets ride the envelope until the columns land (see header).
      view_session_id: e.view_session_id,
      content_hash: e.content_hash,
      max_scroll_pct: e.max_scroll_pct ?? null,
      completion_pct: e.completion_pct ?? null,
      outcome: "ok",
    };
    return {
      event_id: e.event_id,
      occurred_at: t.toISOString(),
      actor_plane: "human",
      viewer_user_id: viewerUserId,
      actor_agent_id: null,
      post_id: e.post_id,
      action: e.action,
      surface: e.surface,
      slate_id: v.slate_id,
      position: e.position,
      weights_version: v.weights_version,
      model_version: v.model_version,
      dwell_ms: e.dwell_ms ?? null,
      client,
      ip_hash: meta.ipHash,
      request_id: meta.requestId,
    };
  });
  // ($1::text)::jsonb + stringify — a bound ARRAY becomes a Postgres array
  // literal under node-pg and fails the jsonb cast; a bound object under
  // postgres.js is fine but a bound STRING under it lands as a jsonb scalar.
  // text-then-cast is the only form both drivers honor identically.
  await db.query("select app.ingest_action_events(($1::text)::jsonb)", [JSON.stringify(rows)]);
}
