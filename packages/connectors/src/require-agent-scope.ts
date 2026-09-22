// packages/connectors/src/require-agent-scope.ts — §5.7.5.
// Worker code, shared by musebook-edge and musebook-mcp; reaches Postgres
// through a `pg` client over HYPERDRIVE_FRESH (never PostgREST).
import type { Actor, Scope } from "@musebook/schema";
import type { Client } from "pg";

/** Same closed set as agent_spend_reservations_purpose_allowed (section 4.11). */
export type SpendPurpose =
  "media.generate" | "connector.call" | "distribution.publish" | "wallet.spend";

export type SpendRequest = {
  estimateAtomic: bigint; // USDC atomic units; 0n is legal and still reserves
  purpose: SpendPurpose;
  /** Scoped by the caller so a client retry replays the same reservation. */
  idempotencyKey: string;
  externalKind?: string; // 'media_job' | 'mcp' | … (how to cancel the far side)
  externalRef?: string;
};

export type OwnerAgent = Extract<Actor, { class: "owner_agent" }>;

export type AgentGate =
  | { ok: true; actor: OwnerAgent; reservationId: string | null }
  | { ok: false; error: string; status: 401 | 403 | 429; remainingAtomic: string | null };

/** Scopes a quarantined delegation may still use (section 10.9): reads only. */
export const QUARANTINE_ALLOWED: ReadonlySet<Scope> = new Set<Scope>([
  "feed:read",
  "post:read",
  "audit:read",
  "analytics:read",
]);

/**
 * `fresh` is a pg Client over HYPERDRIVE_FRESH, created PER REQUEST — never cached
 * in module scope. `limit` is the Worker's rate limiter (Cloudflare rate limiting
 * binding or a KV counter); §15 owns which.
 */
export async function requireAgentScope(
  actor: Actor,
  scope: Scope,
  deps: {
    fresh: Client;
    limit: (key: string, n: number, windowS: number) => Promise<boolean>;
  },
  spend?: SpendRequest,
): Promise<AgentGate> {
  // (1) Class. Humans do not have scopes; their authority is ownership.
  if (actor.class !== "owner_agent") {
    return { ok: false, error: "delegation_required", status: 401, remainingAtomic: null };
  }

  // (2) Scope. The rejection names the missing scope (§16.4.2's error contract).
  if (!actor.scopes.includes(scope)) {
    return { ok: false, error: `insufficient_scope:${scope}`, status: 403, remainingAtomic: null };
  }

  // (3) Delegation state is never cached (5.7.6): one row read per call on the
  //     FRESH binding. app.check_delegation_state enters the kernel plane with
  //     the actor id set, so delegations_actor_read admits this owner's row —
  //     the plane-and-actor switch is one plpgsql call (§4.14).
  const { rows } = await deps.fresh.query(
    `select state, expires_at, rate_limit_per_hour, quarantined_until
       from app.check_delegation_state($1::uuid, $2::uuid)`,
    [actor.delegationId, actor.userId],
  );
  const d = rows[0] as
    | {
        state: string;
        expires_at: string | null;
        rate_limit_per_hour: number;
        quarantined_until: string | null;
      }
    | undefined;

  if (!d || d.state !== "active" || (d.expires_at && new Date(d.expires_at) <= new Date())) {
    return { ok: false, error: "delegation_inactive", status: 401, remainingAtomic: null };
  }
  if (
    d.quarantined_until &&
    new Date(d.quarantined_until) > new Date() &&
    !QUARANTINE_ALLOWED.has(scope)
  ) {
    return { ok: false, error: "delegation_quarantined", status: 403, remainingAtomic: null };
  }

  // (4) Rate limit: delegations.rate_limit_per_hour, a fixed one-hour window keyed
  //     on the delegation. Best-effort by design — a limiter is not a ledger.
  if (!(await deps.limit(`dlg:${actor.delegationId}`, d.rate_limit_per_hour, 3600))) {
    return { ok: false, error: "rate_limited", status: 429, remainingAtomic: null };
  }

  // (5) Budget: a HOLD, not a charge. The caller settles or releases it (below).
  if (!spend) return { ok: true, actor, reservationId: null };

  const r = (
    await deps.fresh.query(
      `select * from public.reserve_agent_spend($1::uuid, $2::numeric, $3::text, $4::text, $5::text, $6::text)`,
      [
        actor.delegationId,
        spend.estimateAtomic.toString(),
        spend.purpose,
        spend.idempotencyKey,
        spend.externalKind ?? null,
        spend.externalRef ?? null,
      ],
    )
  ).rows[0] as
    | { allowed: boolean; reason: string; reservation_id: string | null; remaining_atomic: string }
    | undefined;

  if (!r?.allowed || !r.reservation_id) {
    const reason = r?.reason ?? "reserve_failed";
    // 'delegation_quarantined' / 'delegation_expired' / 'delegation_revoked' are
    // state, not budget; everything else is the cap.
    return {
      ok: false,
      error: reason,
      status: reason.startsWith("delegation_") ? 403 : 429,
      remainingAtomic: r?.remaining_atomic ?? null,
    };
  }
  return { ok: true, actor, reservationId: r.reservation_id };
}
