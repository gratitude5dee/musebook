// apps/web/app/api/cite/route.ts — §7.17 cite_passage's backing route; the
// "Copy citation" button's server half. The edge resolved the actor and the
// access decision before forwarding (§13.5.1 twin-route) — a denied caller
// already got the 402 envelope and never reached this route. What lands here
// is always an allowed read, so the route's job is the two writes: one
// `citations` row bound to `content_hash`, one `agent_cite` action_events row.
export const runtime = "nodejs";

import { z } from "zod";
import { DIRECT_FETCH_SLATE_ID } from "@musebook/schema";
import { readSession } from "@/lib/auth/read-session";
import { requireSameOrigin } from "@/lib/auth/csrf";
import { serviceDb } from "@/lib/db/service";

const Body = z.object({
  post_id: z.uuid(),
  content_hash: z.string().length(64),
  quote: z.string().min(1).max(4000),
  destination: z.string().max(500).optional(),
  surface: z
    .enum(["mcp", "webmcp", "http_md", "http_json", "http_jsonld", "http_html"])
    .default("webmcp"),
  char_start: z.number().int().min(0).optional(),
  char_end: z.number().int().min(0).optional(),
});

/** The edge's actor projection, set by toOrigin only — inbound x-mb-* is
 *  stripped and the hop is authenticated by x-musebook-edge (§6.12.2). */
const ActorHeader = z.object({
  plane: z.enum(["human", "agent"]),
  userId: z.uuid().nullable(),
  agentIdentityId: z.uuid().nullable(),
});

export async function POST(req: Request) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;
  if (b.char_start !== undefined && b.char_end !== undefined && b.char_end < b.char_start) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // x-mb-actor is trusted only off an edge-authenticated hop — the same
  // x-musebook-edge secret proxy.ts requires. A request that bypassed the
  // worker (preview URL, local dev) cannot forge an actor projection.
  const edgeSecret = process.env.MUSEBOOK_EDGE_SECRET;
  const hopAuthenticated =
    edgeSecret !== undefined &&
    edgeSecret !== "" &&
    req.headers.get("x-musebook-edge") === edgeSecret;
  const actorRaw = hopAuthenticated ? req.headers.get("x-mb-actor") : null;
  let actorJson: unknown;
  try {
    actorJson = actorRaw !== null ? JSON.parse(actorRaw) : null;
  } catch {
    actorJson = null;
  }
  const actor = ActorHeader.safeParse(actorJson);
  const session = await readSession(req);
  const agentId = actor.success && actor.data.plane === "agent" ? actor.data.agentIdentityId : null;
  // A human-plane projection with userId null is an anonymous resolution — it
  // must not mask a live session cookie riding the same request.
  const userId =
    (actor.success && actor.data.plane === "human" ? actor.data.userId : null) ??
    session?.userId ??
    null;
  if (agentId === null && userId === null) {
    return Response.json({ error: "sign_in_required" }, { status: 401 });
  }

  // The citation binds to the bytes that were read, not just the row id —
  // an edit between read and cite is a different document.
  const { data: post } = await serviceDb
    .from("posts")
    .select("id, content_hash, citation_template, license_spdx")
    .eq("id", b.post_id)
    .maybeSingle()
    .returns<{
      id: string;
      content_hash: string;
      citation_template: string | null;
      license_spdx: string;
    }>();
  if (post === null) return Response.json({ error: "not_found" }, { status: 404 });
  if (post.content_hash !== b.content_hash) {
    return Response.json({ error: "content_hash_mismatch" }, { status: 409 });
  }

  const { data: citation, error } = await serviceDb
    .from("citations")
    .insert({
      post_id: post.id,
      content_hash: post.content_hash,
      agent_id: agentId,
      user_id: userId,
      surface: b.surface,
      quote: b.quote,
      char_start: b.char_start ?? null,
      char_end: b.char_end ?? null,
      destination: b.destination ?? null,
      self_declared: true,
    })
    .select("id")
    .single()
    .returns<{ id: string }>();
  if (error) return Response.json({ error: "cite_insert_failed" }, { status: 500 });

  // §13.3's write row: agent_cite lands in the same action_events sequence as
  // the read that produced it. The purity constraint drives the shape: agent
  // rows carry actor_agent_id + mcp_tool, human rows carry viewer_user_id.
  // M18.6 requires this synchronous write from the cite path itself; the
  // ingest RPC's fixed column set cannot carry mcp_tool/comment_id/
  // content_hash/outcome, so the direct insert stands.
  // eslint-disable-next-line musebook/no-action-events-at-serve-time -- §16 M18.6 mandates this write
  const { error: eventError } = await serviceDb.from("action_events").insert({
    action: "agent_cite",
    actor_plane: agentId !== null ? "agent" : "human",
    actor_agent_id: agentId,
    viewer_user_id: agentId === null ? userId : null,
    mcp_tool: agentId !== null ? "cite_passage" : null,
    post_id: post.id,
    content_hash: post.content_hash,
    surface: b.surface,
    slate_id: DIRECT_FETCH_SLATE_ID,
    position: 0,
    weights_version: "none",
    model_version: "reverse_chron",
    outcome: "ok",
    comment_id: citation.id,
    client: { evidence: "self_declared_citation", surface: b.surface },
    occurred_at: new Date().toISOString(),
  });
  if (eventError) return Response.json({ error: "event_insert_failed" }, { status: 500 });

  const text =
    post.citation_template ??
    `Musebook post ${post.id} — ${post.license_spdx}. Retrieved ${new Date().toISOString().slice(0, 10)}.`;
  return Response.json({ citation: text, citation_id: citation.id });
}
