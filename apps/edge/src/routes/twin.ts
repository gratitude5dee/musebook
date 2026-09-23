// apps/edge/src/routes/twin.ts — §7.11, verbatim. One handler serves all three
// twins: load a parsed Resource (never a raw row), let the kernel decide and
// render, add nothing the kernel did not already attach.
import { createKernel, etagFor, loadResource, usageHeadersFor } from "@musebook/kernel";
import { representationSchema, type Actor } from "@musebook/schema";
import { paymentRequiredHttp, withSettlement } from "@musebook/x402"; // the HTTP half lives ONLY in this Worker
import { loadPostBySlug } from "../db/posts.js";
import { cached, fresh, release } from "../db/client.js";
import { configureForRequest } from "../kernel/index.js";
import { applyCacheHeaders, cacheHeadersFor } from "../http/cache.js";

const TWIN_REPS = ["markdown", "json", "jsonld"] as const;
const REP_BY_EXT = { md: "markdown", json: "json", jsonld: "jsonld" } as const;

export async function twin(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  match: RegExpMatchArray | null,
  actor: Actor,
): Promise<Response> {
  const slug = match?.[1];
  const rep = REP_BY_EXT[match?.[2] as keyof typeof REP_BY_EXT];
  const as = representationSchema.safeParse(rep);
  if (
    slug === undefined ||
    !as.success ||
    !TWIN_REPS.includes(as.data as (typeof TWIN_REPS)[number])
  ) {
    return new Response("Not found\n", { status: 404 });
  }

  const ro = cached(env);
  const rwDb = fresh(env);
  const rw = configureForRequest(request, env, ctx, { actorUserId: null }, rwDb); // kernel ports on HYPERDRIVE_FRESH
  const kernel = createKernel(rw);
  try {
    const row = await loadPostBySlug(ro, slug, actor.plane === "human" ? actor.userId : null);
    if (row === null) return new Response("Not found\n", { status: 404 });
    const resource = loadResource(row);

    // Per-representation ETag from the kernel — never computed inline (§6.6).
    const etag = etagFor(resource, as.data); // W/"sha256-<16 hex>-<as>"
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, ...cacheHeadersFor({ shared: true, sMaxAge: 300, swr: 86_400 }) },
      });
    }

    const decision = await kernel.resolveAccess(resource, actor);

    if (!decision.allow && decision.challenge !== null) {
      // x402 v2 over HTTP: 402 + PAYMENT-REQUIRED header (base64 PaymentRequired),
      // behind §6.12.8's deny headers — no-store on all three layers, Vary: *.
      // The stored license rides the deny too: a paid post's Content-Usage is
      // declared on the preview, not only after payment (§7.20 check 21).
      const denied = paymentRequiredHttp(decision);
      for (const [k, v] of Object.entries(usageHeadersFor(resource))) {
        denied.headers.set(k, v);
      }
      return applyCacheHeaders(denied, decision, env);
    }

    const rendered = await kernel.renderResource(resource, as.data, decision);
    // §6.8: the settle receipt travels back on the served 200 — without this,
    // a paid twin render proves the settle only in the database.
    return withSettlement(
      applyCacheHeaders(
        new Response(rendered.body, {
          status: rendered.status,
          headers: {
            ...rendered.headers, // link, content-usage, vary, etag — §6.6 headersFor
            "content-type": rendered.mediaType,
            "last-modified": new Date(resource.updatedAt).toUTCString(),
            "cache-tag": `content:${resource.contentHash}`,
            "x-musebook-access": decision.reason,
            "x-musebook-mcp": "https://mcp.musebook.dev/mcp",
          },
        }),
        decision,
        env,
      ),
      decision,
    );
  } finally {
    release(ctx, ro, rwDb);
  }
}
