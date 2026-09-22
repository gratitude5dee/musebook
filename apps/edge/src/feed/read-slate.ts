// apps/edge/src/feed/read-slate.ts — §9.17, verbatim. The whole request-path
// ranking story: ONE select over app.read_slate, refresh fire-and-forget, the
// read never scores.
import type { Actor } from "@musebook/schema";
import { freshClient } from "../db/client.js";
import type { FeedRequest, SlateDoc } from "./types.js";

export async function readSlate(
  env: Env,
  ctx: ExecutionContext,
  actor: Actor,
  req: FeedRequest,
): Promise<SlateDoc | null> {
  const db = freshClient(env); // HYPERDRIVE_FRESH — see §9.17 (read-after-write)
  const { rows } = await db.query("select app.read_slate_doc($1,$2,$3,$4,$5,$6,$7) as slate", [
    actor.plane === "human" ? actor.userId : null,
    actor.plane === "agent" ? actor.agentIdentityId : null,
    req.surface,
    req.cursor?.slateId ?? null,
    req.cursor?.offset ?? -1,
    req.limit,
    actor.plane === "human" ? actor.userId : null,
  ]);
  ctx.waitUntil(db.end());
  const slate = (rows[0]?.slate as SlateDoc | null | undefined) ?? null;

  const stale = slate === null || Date.parse(slate.expires_at) < Date.now();
  const exhausted = slate !== null && slate.items.length < req.limit;
  if (stale || exhausted) {
    // NEVER block the response on a mixer run. The 30-second waitUntil tail is
    // plenty for a ~2 s pass, and if it is not, the next request gets the slate.
    // §9.21's RPC — `Service` types fetch/connect only; narrow to the
    // SlateBuilder entrypoint shape (env.d.ts's MixerBinding).
    const mixer = env.MIXER as unknown as MixerBinding | undefined;
    if (mixer !== undefined) {
      ctx.waitUntil(
        mixer
          .buildSlate({
            surface: req.surface,
            actorUserId: actor.plane === "human" ? actor.userId : null,
            actorAgentId: actor.plane === "agent" ? actor.agentIdentityId : null,
            country: req.country,
          })
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    }
  }
  return slate ?? null; // null -> §9.20's read-time ladder
}
