// apps/edge/src/kernel/grants.ts — GrantPort (§6.12.3).
// KV is a positive-only cache: a present key can never become wrong because a
// mode-2 grant is append-only and keyed on the exact bytes. A miss is NEVER
// authoritative — fall through to HYPERDRIVE_FRESH, always, and backfill the
// key in ctx.waitUntil only for a durable (expires_at IS NULL) grant.
// NEVER cache a negative: Workers KV caches misses for its cacheTtl window
// (min 30 s) in-region, and a cached "no grant" double-charges the agent who
// just settled in another region. If grants ever gain revocation or expiry,
// this scheme breaks — the lookup must move behind a Durable Object (§6.15).
import type { Grant, GrantPort } from "@musebook/kernel";
import { bound, type DbClient } from "../db/client.js";

const keyFor = (contentHash: string, payer: string): string =>
  `g:${contentHash}:${payer.toLowerCase()}`;

interface GrantRow {
  id: string;
  settlement_id: string;
  content_hash: string;
  payer: string;
  expires_at: string | null;
}

const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  settlementId: r.settlement_id,
  contentHash: r.content_hash,
  payer: r.payer,
  expiresAt: r.expires_at,
});

async function readGrantFresh(
  db: DbClient,
  q: { contentHash: string; payer: string | null; agentId: string | null; userId: string | null },
): Promise<Grant | null> {
  // app.find_live_grant performs app.enter('musebook_kernel') inside the
  // function — a sibling app.enter in this SELECT would bind too late (D23).
  const { rows } = await db.query<GrantRow>(
    "select * from app.find_live_grant($1, $2, $3::uuid, $4::uuid, $5::uuid)",
    [q.contentHash, q.payer, q.agentId, q.userId, q.userId],
  );
  return rows[0] === undefined ? null : toGrant(rows[0]);
}

export function makeGrantPort(env: Env, fresh: DbClient, ctx: ExecutionContext): GrantPort {
  const ttlS = Number(env.X402_GRANT_CACHE_TTL_S ?? 86_400);
  return {
    async findLiveGrant(q) {
      if (q.payer !== null) {
        const hit = await bound(env.GRANTS, "GRANTS").get(keyFor(q.contentHash, q.payer), {
          type: "json",
          cacheTtl: ttlS,
        });
        if (hit !== null) return hit as unknown as Grant;
      }
      const grant = await readGrantFresh(fresh, q);
      // Backfill ONLY a hit, and only the durable kind: a row with expires_at is
      // short-lived by definition and must not outlive itself inside KV.
      if (grant !== null && grant.expiresAt === null && q.payer !== null) {
        ctx.waitUntil(
          bound(env.GRANTS, "GRANTS").put(keyFor(q.contentHash, q.payer), JSON.stringify(grant)),
        );
      }
      return grant;
    },

    async mintGrant(g) {
      const { rows } = await fresh.query<GrantRow>(
        `select * from app.mint_grant(
           $1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, $7::timestamptz, $6::uuid)`,
        [
          g.settlementId,
          g.contentHash,
          g.postId,
          g.payer,
          g.subjectAgentId,
          g.subjectUserId,
          g.expiresAt,
        ],
      );
      const row = rows[0];
      if (row !== undefined) return toGrant(row);
      // Conflict: a live grant already covers (payer, content_hash). The unique
      // index means the winner is the only row that can match — read it back.
      const existing = await readGrantFresh(fresh, {
        contentHash: g.contentHash,
        payer: g.payer,
        agentId: null,
        userId: null,
      });
      if (existing === null) throw new Error("mintGrant: insert lost and no live grant found");
      return existing;
    },
  };
}
