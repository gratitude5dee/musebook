// apps/mcp/src/tools/purchase-access.ts — §7.4 tool 8: explicit x402 purchase.
// The kernel path is identical to get_post's: resolveAccess settles the
// payment from _meta["x402/payment"]; without one it returns the pinned
// challenge. The tool's own additions: idempotency_key recorded so a retry
// never double-charges, and max_amount_atomic refused BEFORE the payment is
// even presented.
import type { McpServer } from "@modelcontextprotocol/server";
import {
  configureKernel,
  loadResource,
  renderResource,
  resolveAccess,
  mintsDurableGrant,
} from "@musebook/kernel";
import { asDb, cached, fresh, release } from "../db/client.js";
import { loadPostByPostId, loadPostBySlug } from "../db/posts.js";
import { portsFor } from "../kernel/configure.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { recordAgentEvent } from "../telemetry.js";
import { errorResult, notFound, toolResultFrom } from "./shared.js";
import { purchaseAccessInput } from "./schemas.js";

export function registerPurchaseAccess(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "purchase_access",
    {
      title: "Purchase access to a Musebook post",
      description:
        "Buys read access to a priced post. First call returns isError:true with an x402 " +
        'PaymentRequired; retry with the signed payment in _meta["x402/payment"]. idempotency_key ' +
        "is required — a retry with the same key never charges twice. The returned grant_id " +
        "re-opens the same content_hash for free until the post is edited.",
      inputSchema: purchaseAccessInput,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args, toolCtx) => {
      const ro = cached(env);
      const rw = fresh(env);
      try {
        const actor = await resolveActorFromMcp(toolCtx, env, ctx);

        // Idempotency pre-read: a stored terminal response short-circuits
        // before any quote or settlement work. The idempotency_keys row is
        // written after success only — a failed settle must be retryable.
        const principal = actor.userId ?? actor.payerAddress ?? "anonymous";
        const prior = await rw.begin(async (tx) => {
          await tx.unsafe("select app.enter('musebook_jobs', $1::uuid)", [actor.userId]);
          return (await tx.unsafe(
            `select response_body from public.idempotency_keys
              where endpoint = 'mcp:purchase_access' and idempotency_key = $1
                and actor = $2 and state = 'complete'`,
            [args.idempotency_key, principal],
          )) as { response_body: unknown }[];
        });
        if (prior[0] !== undefined) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(prior[0].response_body) }],
            structuredContent: prior[0].response_body as Record<string, unknown>,
          };
        }

        const roDb = asDb(ro);
        const row =
          args.post_id !== undefined
            ? await loadPostByPostId(roDb, args.post_id, actor.userId)
            : await loadPostBySlug(roDb, args.post_slug ?? "", actor.userId);
        const resource = row === null ? null : loadResource(row);
        if (resource === null) return notFound("post");
        if (!mintsDurableGrant(resource)) {
          return errorResult(
            "not_purchasable",
            "This post does not mint a durable grant — buy per-fetch on get_post or download_asset.",
          );
        }

        // max_amount_atomic is checked against the *price*, before a quote is
        // even pinned — cheaper than building the challenge first.
        if (
          args.max_amount_atomic !== undefined &&
          BigInt(resource.priceAtomic) > BigInt(args.max_amount_atomic)
        ) {
          return errorResult(
            "price_exceeds_cap",
            `Post costs ${resource.priceAtomic} atomic, above max_amount_atomic ${args.max_amount_atomic}.`,
          );
        }

        configureKernel(portsFor(env, ctx, asDb(rw), actor.userId));
        const decision = await resolveAccess(resource, actor);
        const rendered = await renderResource(resource, "mcp", decision);

        if (!decision.allow) {
          recordAgentEvent(env, ctx, {
            actor,
            tool: "purchase_access",
            outcome: "payment_required",
            contentHash: resource.contentHash,
            postId: resource.postId,
          });
          return toolResultFrom(rendered, decision, resource);
        }

        const body = {
          purchased: true,
          post_id: resource.postId,
          slug: resource.slug,
          content_hash: resource.contentHash,
          grant:
            decision.grantId !== null
              ? { grant_id: decision.grantId, expires_at: null, scope: "post:read" }
              : null,
          settlement_id: decision.settlementId,
          reason: decision.reason,
        };
        recordAgentEvent(env, ctx, {
          actor,
          tool: "purchase_access",
          outcome: "ok",
          contentHash: resource.contentHash,
          postId: resource.postId,
        });

        // Success path → record the terminal response for key-replays.
        ctx.waitUntil(
          (async () => {
            try {
              await rw.begin(async (tx) => {
                await tx.unsafe("select app.enter('musebook_jobs', $1::uuid)", [actor.userId]);
                await tx.unsafe(
                  `insert into public.idempotency_keys
                     (endpoint, idempotency_key, actor, state, response_status, response_body)
                   values ('mcp:purchase_access', $1, $2, 'complete', 200, $3::jsonb)
                   on conflict (endpoint, idempotency_key, actor) do nothing`,
                  [args.idempotency_key, principal, body],
                );
              });
            } catch {
              // Idempotency bookkeeping must never fail a settled purchase.
            }
          })(),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(body) }],
          structuredContent: body,
          ...(rendered.mcpMeta !== null ? { _meta: rendered.mcpMeta } : {}),
        };
      } finally {
        release(ctx, ro, rw);
      }
    },
  );
}
