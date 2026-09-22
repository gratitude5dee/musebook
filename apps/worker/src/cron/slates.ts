// apps/worker/src/cron/slates.ts — the hourly slate rebuild (§9.19/§9.20).
// It writes the anonymous home slate through SlateBuilder and mirrors it into
// the Cache API so rung R3 of the read ladder can serve it when the DB is
// unreachable. The per-viewer rebuilds are kicked by the request path itself.
import { buildSlateCore } from "../slate-builder.js";
import { pgFresh } from "../db.js";

const SURFACES = ["foryou", "latest", "reels"] as const;
const CACHE_BASE = "https://musebook.dev/.internal/anon-slate";

/** Rebuild the anonymous slate for each surface. Called by the `0 * * * *`
 *  cron arm; the M7 work extends this to the scored slate (§9.19's real model). */
export async function rebuildAnonSlates(env: Env, ctx: ExecutionContext): Promise<void> {
  for (const surface of SURFACES) {
    const { slateId } = await buildSlateCore(env, { surface });
    if (slateId === null) continue;
    // The cached copy is the R3 document — it has the SAME shape the feed
    // route returns so rung3() can hand it out unchanged.
    const db = await pgFresh(env);
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
