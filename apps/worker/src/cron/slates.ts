// apps/worker/src/cron/slates.ts — the hourly slate rebuild (§9.17).
// Two halves, both inside the `0 * * * *` arm:
//   1. every viewer with viewer_recent_actions.computed_at inside
//      MixerWarmViewerHours gets a `home` and a `reels` slate, in chunks;
//   2. the one anonymous `home` slate (viewer_user_id is null) that §9.20's
//      rung R3 serves, mirrored into the Cache API.
import { buildSlateCore } from "../slate-builder.js";
import { pgFreshJobs } from "../db.js";

const SURFACES = ["home", "reels"] as const;
const CACHE_BASE = "https://musebook.dev/.internal/anon-slate";
const WARM_CHUNK = 8;

function envNum(env: Env, name: string, fallback: number): number {
  const v = (env as unknown as Record<string, unknown>)[name];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** §9.17 — warm viewers × {home, reels}, chunked so we don't burn the whole
 *  connection pool on the tick. A build failure for one viewer is logged and
 *  skipped, never thrown into the rest of the chunk. */
export async function rebuildWarmSlates(env: Env): Promise<void> {
  const warmHours = envNum(env, "MUSE_MIXER_WARM_VIEWER_HOURS", 24);
  // viewer_recent_actions is jobs-plane — session-level `set role` on this
  // per-tick connection (pgFreshJobs), same as the per-build connections.
  const db = await pgFreshJobs(env);
  try {
    const { rows } = await db.query<{ viewer_user_id: string }>(
      `select distinct viewer_user_id
         from public.viewer_recent_actions
        where computed_at > now() - make_interval(hours => $1)
        limit 5000`,
      [warmHours],
    );
    const viewerIds = rows.map((r) => r.viewer_user_id);
    for (let i = 0; i < viewerIds.length; i += WARM_CHUNK) {
      const chunk = viewerIds.slice(i, i + WARM_CHUNK);
      await Promise.allSettled(
        chunk.flatMap((viewerUserId) =>
          SURFACES.map((surface) =>
            buildSlateCore(env, { surface, actorUserId: viewerUserId }),
          ),
        ),
      );
    }
  } finally {
    await db.end();
  }
}

/** §9.20 rung R3 — the anonymous `home` slate that survives a DB outage,
 *  written to the Cache API in the exact shape the feed route returns. */
export async function rebuildAnonSlates(env: Env, ctx: ExecutionContext): Promise<void> {
  for (const surface of SURFACES) {
    const { slateId } = await buildSlateCore(env, { surface });
    if (slateId === null) continue;
    const db = await pgFreshJobs(env);
    try {
      const { rows } = await db.query<{
        doc: { items: unknown; slate_id: string } | null;
      }>(
        "select app.read_slate_doc(null::uuid, null::uuid, $1, $2::uuid, -1, 100, null::uuid) as doc",
        [surface, slateId],
      );
      const doc = rows[0]?.doc;
      if (doc === undefined || doc === null) continue;
      const res = new Response(
        JSON.stringify({
          items: doc.items,
          nextCursor: null,
          slateId: doc.slate_id,
        }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
          },
        },
      );
      ctx.waitUntil(caches.default.put(`${CACHE_BASE}/${surface}`, res));
    } finally {
      await db.end();
    }
  }
}
