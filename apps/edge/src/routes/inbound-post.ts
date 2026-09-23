// apps/edge/src/routes/inbound-post.ts — POST /api/v1/posts (§12.2.9).
// The inbound half of the upstream provider pair: an unmodified
// musebook.provider.ts posts { markdown, title, access } with the delegation
// token as Bearer and Idempotency-Key = its own post id. The route writes
// what submit_post writes — insert_draft_post carries the license columns off
// the owner's creator_publishing_defaults — and honours the key through
// public.idempotency_keys, so Postiz's at-least-once retry is a replay, not a
// duplicate post. `access` maps through the kernel's accessToPublishMode();
// the column name never crosses the wire.
import { canonicalMarkdown, contentHash } from "@musebook/content";
import { accessToPublishMode } from "@musebook/kernel";
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { fresh } from "../db/client.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

interface InboundBody {
  markdown?: unknown;
  title?: unknown;
  access?: unknown;
  tags?: unknown;
}

export async function handleInboundPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "owner_agent" || actor.delegationId === null) {
    return json({ success: false, error: "delegation_required" }, 401);
  }
  // submit_post's rule: publishing (always, here) or a paid intent needs
  // post:publish on top of post:write.
  if (!actor.scopes.includes("post:write") || !actor.scopes.includes("post:publish")) {
    return json(
      { success: false, error: "scope_denied", needed: ["post:write", "post:publish"] },
      403,
    );
  }

  const raw = (await request.json().catch(() => null)) as InboundBody | null;
  if (typeof raw?.markdown !== "string" || raw.markdown.length === 0) {
    return json({ success: false, error: "markdown_required" }, 400);
  }
  const access = raw.access === "toll" || raw.access === "gated" ? raw.access : "open";
  const idemKey = request.headers.get("idempotency-key");
  if (idemKey === null || idemKey.length === 0) {
    return json({ success: false, error: "idempotency_key_required" }, 400);
  }

  const canonical = canonicalMarkdown(raw.markdown);
  const hash = contentHash(canonical);
  const wantsPaid = access !== "open";
  // The provider always publishes; a RequiresApproval delegation still lands
  // pending_approval — insert_draft_post owns that branch via p_pending.
  const pending = wantsPaid || actor.requiresApproval;
  const tags = Array.isArray(raw?.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string")
    : [];

  const db = fresh(env);
  try {
    const { rows } = await db.query<{
      post_id: string;
      approval_id: string | null;
      job_id: string;
    }>(
      `select * from public.insert_draft_post(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text[],
         $7::text, $8::boolean, $9::uuid, $10::uuid,
         $11::text[], $12::text, $13::text, $14::text,
         $15::numeric(78,0), $16::text)`,
      [
        actor.userId,
        actor.agentIdentityId,
        actor.delegationId,
        hash,
        canonical,
        tags,
        accessToPublishMode(access),
        pending,
        null,
        null,
        ["musebook"],
        typeof raw.title === "string" ? raw.title : null,
        null,
        "en",
        null,
        null,
      ],
    );
    const created = rows[0];
    if (created === undefined) return json({ success: false, error: "insert_failed" }, 500);

    const { rows: res } = await db.query<{ canonical_url: string | null; slug: string }>(
      `select canonical_url, slug from app.load_resource_by_post_id($1::uuid)`,
      [created.post_id],
    );
    const url =
      res[0]?.canonical_url ??
      (res[0]?.slug !== undefined ? `https://musebook.dev/p/${res[0].slug}` : null);

    const responseBody = {
      success: true,
      post: {
        id: created.post_id,
        url,
        status: pending ? "pending_approval" : "published",
        approval_id: created.approval_id,
        content_hash: hash,
      },
    };

    // Exactly-once on the wire: the first Idempotency-Key writer's response is
    // the canonical one; a replay returns the stored body untouched.
    const { rows: idem } = await db.query<{ applied: boolean; response_body: unknown }>(
      "select * from app.idempotent_record('inbound.posts', $1, $2, $3::jsonb)",
      [idemKey, actor.delegationId, JSON.stringify(responseBody)],
    );
    const stored = idem[0];
    if (stored !== undefined && stored.applied === false) {
      return json(stored.response_body, 200);
    }
    return json(responseBody, 200);
  } finally {
    await db.end().catch(() => undefined);
  }
}
