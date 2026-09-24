// apps/edge/src/routes/artifacts.ts — §11.18: POST /api/artifacts/{id}/ticket
// and the §11.17 fork endpoint. The mint path is the ONLY place a paid
// artifact's access decision runs; the /t/ read path it certifies carries no
// database at all (apps/edge/src/artifacts.ts).
import { createKernel, loadResource } from "@musebook/kernel";
import type { Actor } from "@musebook/schema";
import { DIRECT_FETCH_SLATE_ID } from "@musebook/schema";
import { importTicketSigningKey, mintTicket } from "@musebook/artifacts";
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { bound, fresh } from "../db/client.js";
import { challengeResponse } from "../http.js";
import { portsFor } from "../kernel/configure.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

interface ArtifactForTicket {
  post_id: string;
  artifact_id: string;
  kind: string;
  status: string;
  current_version: string | null;
  visibility: string | null;
  entry_path: string | null;
}

/** §5.6's payerAddress resolver, extended with the session principal — the
 *  same subject vocabulary the durable-grant writer uses. */
function subjectOf(actor: Actor): string {
  if (actor.payment !== null) return actor.payment.payload.authorization.from.toLowerCase();
  if (actor.payerAddress !== null) return actor.payerAddress.toLowerCase();
  if (actor.userId !== null) return `user:${actor.userId}`;
  return actor.class === "crawler_agent" && actor.agentIdentityId !== null
    ? `agent:${actor.agentIdentityId}`
    : "anon";
}

/** POST /api/artifacts/{artifactId}/ticket — mints the 300-second URL the
 *  /t/{ticket}/ route serves. Free artifacts answer the public URL directly. */
export async function handleArtifactTicket(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  artifactId: string,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  const db = fresh(env);
  try {
    const ports = portsFor(request, env, ctx, { actorUserId: null }, db);
    const kernel = createKernel(ports);
    const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
    if (actor instanceof Response) return actor;

    const { rows } = await db.query<ArtifactForTicket>(
      "select * from app.load_artifact_for_ticket($1::uuid, $2::uuid)",
      [artifactId, actor.userId],
    );
    const artifact = rows[0];
    if (artifact === undefined || artifact.status !== "live") {
      return json({ error: "artifact_not_found" }, 404);
    }

    const row = await ports.resources.loadRowByPostId(artifact.post_id);
    if (row === null) return json({ error: "artifact_not_found" }, 404);
    const resource = loadResource(row);
    // THE decision — the only place one is made for a paid artifact.
    const decision = await kernel.resolveAccess(resource, actor);
    if (!decision.allow) return challengeResponse(decision);

    const host = bound(env.ARTIFACT_HOST, "ARTIFACT_HOST");
    const version = artifact.current_version;
    if (version === null) return json({ error: "artifact_unpublished" }, 404);
    const entry = artifact.entry_path ?? "index.html";

    if (artifact.visibility === "public") {
      return json({
        url: `https://${host}/a/${artifactId}/${version}/${entry}`,
      });
    }

    const pem = env.ARTIFACT_TICKET_SIGNING_KEY;
    if (pem === undefined || pem === "") {
      return json({ error: "ticket_signing_unconfigured" }, 503);
    }
    const key = await importTicketSigningKey(pem);
    const ticket = await mintTicket(key, {
      a: artifactId,
      v: version,
      ch: resource.contentHash,
      s: subjectOf(actor),
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    return json({ url: `https://${host}/t/${ticket}/a/${artifactId}/${version}/${entry}` });
  } finally {
    ctx.waitUntil(db.end().catch(() => undefined));
  }
}

/** POST /api/artifacts/{artifactId}/fork — §11.17: pointer copy + permission
 *  check inside app.fork_artifact, then the fork_app action on ingest. */
export async function handleArtifactFork(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  artifactId: string,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  // fork_artifact attributes to a human: human_creator directly, owner_agent
  // through the human it acts for. A crawler has no user to attribute to.
  if (actor.userId === null) return json({ error: "forbidden" }, 403);
  // crawler_agent never reaches here (userId null above), so only owner_agent
  // carries an identity to attribute.
  const agentId = actor.class === "owner_agent" ? actor.agentIdentityId : null;

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const slug = typeof raw?.slug === "string" ? raw.slug : null;
  const title = typeof raw?.title === "string" ? raw.title : null;
  const markdown = typeof raw?.markdown === "string" ? raw.markdown : null;
  if (slug === null || title === null || markdown === null) {
    return json({ error: "slug_title_markdown_required" }, 400);
  }

  const db = fresh(env);
  try {
    const { rows } = await db.query<{ post_id: string; artifact_id: string }>(
      "select * from app.fork_artifact($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)",
      [artifactId, actor.userId, agentId, slug, title, markdown],
    );
    const forked = rows[0];
    if (forked === undefined) return json({ error: "fork_failed" }, 500);

    // §11.17 step 5: fork_app in MUSE_ACTIONS order, logged the moment it ships.
    ctx.waitUntil(
      db
        .query("select app.ingest_action_events(($1::text)::jsonb)", [
          JSON.stringify([
            {
              actor_plane: actor.plane,
              viewer_user_id: actor.plane === "human" ? actor.userId : null,
              actor_agent_id: actor.plane === "agent" ? agentId : null,
              post_id: forked.post_id,
              action: "fork_app",
              surface: "artifact",
              slate_id: DIRECT_FETCH_SLATE_ID,
              position: 0,
              weights_version: "none",
              model_version: "reverse_chron",
            },
          ]),
        ])
        .catch(() => undefined),
    );
    return json({ postId: forked.post_id, artifactId: forked.artifact_id }, 201);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P0002") return json({ error: "artifact_not_found" }, 404);
    if (code === "42501") return json({ error: "remix_not_allowed" }, 403);
    throw e;
  } finally {
    ctx.waitUntil(db.end().catch(() => undefined));
  }
}
