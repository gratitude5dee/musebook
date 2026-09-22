// apps/edge/src/media.ts — §6.12.4 verbatim: the paid-media read path.
// Free media never touches this file — it lives on the cdn. R2 custom domain
// with no Worker in front (G-MEDIA-DOMAIN). media. and artifacts. only.
import { createKernel, loadResource } from "@musebook/kernel";
import { withSettlement } from "@musebook/x402";
import { lookupAsset } from "./db/assets.js";
import { actorOrResponse, asIdentityEnv } from "./auth/resolve-actor.js";
import { bound, fresh } from "./db/client.js";
import { challengeResponse, notFound, passthrough, rangeHeaders } from "./http.js";
import { portsFor } from "./kernel/configure.js";

/**
 * The hostname guard is upstream — index.ts only calls this for MEDIA_HOST /
 * ARTIFACT_HOST. Everything about the object key comes from the path.
 */
export async function serveMedia(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.slice(1));
  if (key === "" || key.includes("..")) return notFound();

  const db = fresh(env);
  try {
    const asset = await lookupAsset(db, key);
    if (asset === null) return notFound();
    if (asset.storage === "r2_public") {
      // A public bucket object's URL may exist here by misroute — refuse rather
      // than serving free media through the paid path.
      return notFound();
    }

    // Same client for asset lookup and the kernel ports — one socket, one
    // close point (the finally below). portsFor never ends what it is given.
    const ports = portsFor(request, env, ctx, { actorUserId: null }, db);
    const kernel = createKernel(ports);
    const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
    if (actor instanceof Response) return actor;
    const row = await ports.resources.loadRowByPostId(asset.postId);
    if (row === null) return notFound();
    const resource = loadResource(row);
    const decision = await kernel.resolveAccess(resource, actor);
    if (!decision.allow) return challengeResponse(decision);

    const bucket = bound(
      url.hostname === env.ARTIFACT_HOST ? env.ARTIFACTS : env.PAID_MEDIA,
      url.hostname === env.ARTIFACT_HOST ? "ARTIFACTS" : "PAID_MEDIA",
    );
    const range = request.headers.get("range");
    const conditional = [
      "if-match",
      "if-none-match",
      "if-modified-since",
      "if-unmodified-since",
    ].some((h) => request.headers.has(h));

    // Range/conditional requests skip the exports gateway: `R2ObjectBody` in
    // fetch context can't express a byte range or an onlyIf precondition;
    // bucket.get serves both inline.
    if (range !== null || conditional) {
      return withSettlement(await fromR2(bucket, request, key), decision);
    }
    // The service binding keeps the hot path off the request's subrequest
    // budget and lets the PaidMedia export stream without re-entering index.ts.
    // The original URL goes through (§6.12.4) — the entrypoint re-derives the
    // bucket from the hostname, and payment/auth headers are stripped by
    // passthrough() so they can never enter a cache key or a cached response.
    const upstream = new Request(url.toString(), {
      method: request.method,
      headers: passthrough(request.headers),
    });
    const res = await (ctx.exports.PaidMedia as Fetcher).fetch(upstream);
    return withSettlement(
      new Response(res.body, { status: res.status, headers: res.headers }),
      decision,
    );
  } finally {
    ctx.waitUntil(db.end().catch(() => undefined));
  }
}

/** 304/412/206/200 for the range and conditional arms of the read path. */
async function fromR2(bucket: R2Bucket, request: Request, key: string): Promise<Response> {
  const object = await bucket.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (object === null || object === undefined || !("body" in object)) {
    // onlyIf failed before a body was produced — R2 does not distinguish, so
    // an if-none-match that matched serves 304, everything else 412.
    const status = request.headers.has("if-none-match") ? 304 : 412;
    return new Response(null, { status });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("etag", object.httpEtag);

  if (object.range !== undefined) {
    const h = rangeHeaders(object.range, object.size);
    h.forEach((v, k) => headers.set(k, v));
    return new Response(request.method === "HEAD" ? null : object.body, {
      status: 206,
      headers,
    });
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}
