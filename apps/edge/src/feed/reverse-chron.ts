// apps/edge/src/feed/reverse-chron.ts — §9.20 rung R2: no slate, or a cursor
// past the last item. One keyset page over posts_feed_idx, persisted as a slate
// with the seeded literals ('none' / 'reverse_chron') so spine invariant 3
// holds for the very first request a viewer ever makes — then the build fires
// in waitUntil and the response is marked degraded.
import type { Actor } from "@musebook/schema";
import { fresh } from "../db/client.js";
import type { FeedRequest, SlateDoc, SlateItem } from "./types.js";

export interface ReverseChronResult {
  slate: SlateDoc;
  /** The keyset anchor for the NEXT R2 page — the last row's (published_at, id). */
  anchor: { publishedAt: string; postId: string } | null;
}

export async function reverseChronPage(
  env: Env,
  ctx: ExecutionContext,
  actor: Actor,
  req: FeedRequest,
): Promise<ReverseChronResult | null> {
  const db = fresh(env);
  try {
    // A cursor past the persisted page's last item (§9.20 R2) continues the
    // keyset from the post sitting at the cursor's position in that slate —
    // not from the top, or page 2 would replay page 1.
    let anchor: { publishedAt: string | null; postId: string | null } = {
      publishedAt: null,
      postId: null,
    };
    if (req.cursor !== null && req.cursor !== undefined) {
      const { rows: anchorRows } = await db.query<{
        published_at: string;
        post_id: string;
      }>("select * from app.slate_anchor($1::uuid, $2)", [req.cursor.slateId, req.cursor.offset]);
      if (anchorRows[0] !== undefined) {
        anchor = { publishedAt: anchorRows[0].published_at, postId: anchorRows[0].post_id };
      }
    }
    const { rows } = await db.query<SlateItem>(
      "select * from app.reverse_chron_page($1::uuid, $2, $3::timestamptz, $4::uuid, $5, $6::uuid)",
      [
        actor.plane === "human" ? actor.userId : null,
        req.surface,
        anchor.publishedAt,
        anchor.postId,
        req.limit,
        actor.plane === "human" ? actor.userId : null,
      ],
    );
    if (rows.length === 0) return null;

    // Persist the page as a slate — the response's items carry this slate_id
    // and positions dense from 0, which is all §13's ingest asks.
    const ttl = Number(env.MUSE_SLATE_TTL_SECONDS ?? 900);
    const { rows: slateRows } = await db.query<{ id: string }>(
      "select app.write_reverse_chron_slate($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::uuid) as id",
      [
        actor.plane === "human" ? actor.userId : null,
        actor.plane === "agent" ? actor.agentIdentityId : null,
        req.surface,
        rows.map((r) => ({ post_id: r.post_id })),
        ttl,
        actor.plane === "human" ? actor.userId : null,
      ],
    );
    const slateId = slateRows[0]?.id ?? null;

    const last = rows[rows.length - 1] as SlateItem;
    return {
      slate: {
        slate_id: slateId ?? "",
        surface: req.surface,
        weights_version: "none",
        model_version: "reverse_chron",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        candidate_count: rows.length,
        items: rows,
      },
      anchor:
        slateId === null || last.published_at === null
          ? null
          : { publishedAt: last.published_at, postId: last.post_id },
    };
  } finally {
    ctx.waitUntil(db.end().catch(() => undefined));
  }
}
