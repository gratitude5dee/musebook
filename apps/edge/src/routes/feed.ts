// apps/edge/src/routes/feed.ts — §9.21's three routes + §9.20's read-time
// ladder, R0..R4. A feed route never 500s.
import type { Actor } from "@musebook/schema";
import { surfaceSchema } from "@musebook/schema";
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { encodeCursor, decodeCursor } from "../feed/cursor.js";
import { readSlate } from "../feed/read-slate.js";
import { reverseChronPage } from "../feed/reverse-chron.js";
import type { FeedRequest, FeedResponse, SlateDoc } from "../feed/types.js";
import { opsLog } from "../ops.js";

interface FeedBody {
  surface?: FeedRequest["surface"];
  cursor?: string;
  limit?: number;
}

// Hand-rolled: §3.2's zod split means apps/edge never imports zod directly.
// Unknown keys are dropped, matching the zod object this replaces.
function parseBody(raw: unknown): FeedBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: FeedBody = {};
  if ("surface" in o) {
    const s = surfaceSchema.safeParse(o.surface);
    if (!s.success) return null;
    out.surface = s.data;
  }
  if (o.cursor !== undefined) {
    if (typeof o.cursor !== "string" || o.cursor.length > 512) return null;
    out.cursor = o.cursor;
  }
  if (o.limit !== undefined) {
    if (typeof o.limit !== "number" || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > 100) {
      return null;
    }
    out.limit = o.limit;
  }
  return out;
}

const NO_STORE = { "cache-control": "private, no-store" } as const;

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? NO_STORE),
    },
  });
}

async function feedRequestFrom(
  request: Request,
  forcedSurface?: string,
): Promise<FeedRequest | null> {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = parseBody(raw);
  if (parsed === null) return null;
  const surface = forcedSurface ?? parsed.surface;
  if (surface === undefined) return null;
  return {
    surface,
    cursor: decodeCursor(parsed.cursor ?? null),
    limit: parsed.limit ?? 20,
    country: (request.cf?.country as string | undefined) ?? "XX",
  };
}

/** R0+R1: a slate row exists — serve it, stale or fresh; the rebuild already
 *  fired inside readSlate when either flag held. */
function fromSlate(slate: SlateDoc): FeedResponse {
  const stale = Date.parse(slate.expires_at) < Date.now();
  const last = slate.items[slate.items.length - 1];
  return {
    items: slate.items,
    nextCursor:
      last === undefined
        ? null
        : encodeCursor({
            slateId: slate.slate_id,
            offset: last.position,
            weightsVersion: slate.weights_version,
          }),
    slateId: slate.slate_id,
    ...(stale ? { stale: true } : {}),
  };
}

/** R2 — one keyset page, persisted as a 'none'/'reverse_chron' slate. */
async function rung2(
  env: Env,
  ctx: ExecutionContext,
  actor: Actor,
  req: FeedRequest,
): Promise<FeedResponse | null> {
  const rc = await reverseChronPage(env, ctx, actor, req);
  if (rc === null || rc.slate.slate_id === "") return null;
  const last = rc.slate.items[rc.slate.items.length - 1];
  return {
    items: rc.slate.items,
    nextCursor:
      last === undefined
        ? null
        : encodeCursor({
            slateId: rc.slate.slate_id,
            offset: last.position,
            weightsVersion: "none",
          }),
    slateId: rc.slate.slate_id,
    degraded: true,
  };
}

/** R3 — the hourly anonymous home slate, read back from the Cache API. */
async function rung3(req: FeedRequest): Promise<FeedResponse | null> {
  try {
    const key = `https://musebook.dev/.internal/anon-slate/${req.surface}`;
    const res = await caches.default.match(key);
    if (res === undefined) return null;
    const slate = await res.json<FeedResponse>();
    return { ...slate, degraded: true };
  } catch {
    return null;
  }
}

/** R4 — even that is missing. 200, empty, degraded, alert. Never a 500. */
function rung4(): FeedResponse {
  return { items: [], nextCursor: null, slateId: null, degraded: true };
}

async function handleFeed(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  forcedSurface?: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: NO_STORE });
  }
  const req = await feedRequestFrom(request, forcedSurface);
  if (req === null) return json({ error: "bad_request" }, { status: 400 });

  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;

  // R0/R1 — one read. A null slate, an expired slate, or a cursor past the
  // last item all fall through to R2 (the refresh already fired).
  let slate: SlateDoc | null;
  try {
    slate = await readSlate(env, ctx, actor, req);
  } catch {
    slate = null; // DB unreachable -> R3
  }

  if (slate !== null) {
    const cursorPastEnd =
      req.cursor !== null && req.cursor !== undefined && slate.items.length === 0;
    if (!cursorPastEnd) {
      const weightsDrift =
        req.cursor !== null &&
        req.cursor !== undefined &&
        req.cursor.weightsVersion !== slate.weights_version;
      if (!weightsDrift) {
        return json(fromSlate(slate), {
          headers: {
            ...NO_STORE,
            "cloudflare-cdn-cache-control": "public, s-maxage=600",
            "cache-tag": "feed",
          },
        });
      }
      // A weights-version mismatch discards the cursor — re-read as page 1.
      const reset = await readSlate(env, ctx, actor, { ...req, cursor: null });
      if (reset !== null) return json(fromSlate(reset));
    }
  }

  // R2 — reverse-chron keyset page, logged as a slate.
  try {
    const degraded = await rung2(env, ctx, actor, req);
    if (degraded !== null) return json(degraded);
  } catch {
    // DB unreachable -> R3.
  }

  // R3 — the cached anonymous slate.
  const cachedSlate = await rung3(req);
  if (cachedSlate !== null) return json(cachedSlate);

  // R4 — 200, empty, degraded, alert. Never a 500 on a feed.
  ctx.waitUntil(
    opsLog(env, {
      component: "feed",
      event_name: "r4_empty_feed",
      level: "error",
      metadata: { surface: req.surface },
    }),
  );
  return json(rung4());
}

export const handleFeedForYou = (request: Request, env: Env, ctx: ExecutionContext) =>
  handleFeed(request, env, ctx);

export const handleFeedReels = (request: Request, env: Env, ctx: ExecutionContext) =>
  handleFeed(request, env, ctx, "reels");

/** §9.21: raw ranked items with scores — at M6 the same slate read, projected
 *  to {postId, contentHash, score, source}. */
export async function handleFeedScored(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: NO_STORE });
  }
  const req = await feedRequestFrom(request);
  if (req === null) return json({ error: "bad_request" }, { status: 400 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  const slate = await readSlate(env, ctx, actor, req).catch(() => null);
  if (slate === null) return json({ candidates: [], slateId: null, degraded: true });
  return json({
    candidates: slate.items.map((i) => ({
      postId: i.post_id,
      contentHash: i.content_hash,
      score: i.score,
      source: i.source,
    })),
    slateId: slate.slate_id,
  });
}
