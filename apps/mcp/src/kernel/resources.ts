// apps/edge/src/kernel/resources.ts — ResourcePort (§6.5).
// Role-scoped statements run on HYPERDRIVE_FRESH (rule 3, §4.14.1: the cache
// key on the cached binding provably does not incorporate the connection's
// role, and a cached gated body would be served stale). The plane is entered
// inside the helper (D23: a sibling app.enter in the same SELECT binds too
// late at plan time).
import type { ResourcePort } from "@musebook/kernel";
import type { DbClient } from "../db/client.js";
import { loadPostByPostId, loadPostBySlug } from "../db/posts.js";

/** MCP variant: the actor is resolved per tool call, so the viewer id is
 *  passed per load instead of through a request-scoped closure. */
export function makeResourcePort(
  fresh: DbClient,
  actorUserId: () => string | null = () => null,
): ResourcePort {
  return {
    loadRowBySlug: (slug) => loadPostBySlug(fresh, slug, actorUserId()),
    loadRowByPostId: (postId) => loadPostByPostId(fresh, postId, actorUserId()),
  };
}
