// apps/mcp/src/auth/props-to-actor.ts — §7.6.4's re-read that makes the token
// non-authoritative. `props` is only a cache: the delegation row re-read on
// HYPERDRIVE_FRESH every call is the authority, so narrowing or revoking a
// live delegation takes effect on the very next call rather than at the next
// token refresh.
import type { Sql } from "../db/client.js";

export interface GrantProps {
  /** delegations.id the grant was bound to at consent time. */
  dlg?: string;
  /** delegations.owner_user_id — the human this agent acts for. */
  sub?: string;
  /** delegations.agent_identity_id. */
  aid?: string;
  /** Cached scope list — NEVER authoritative. */
  scp?: string[];
}

export interface DelegationRow {
  delegation_id: string;
  owner_user_id: string;
  agent_identity_id: string;
  connector_slug: string;
  scopes: string[];
  requires_approval: boolean;
  state: string;
  expires_at: string | null;
}

/** Returns the live delegation, or null on: missing row, state <> 'active',
 *  expiry past, or owner mismatch (props must not out-rank the row). Scopes
 *  come from the ROW, never from props.scp — §5.8.1 verbatim. */
export async function checkGrant(fresh: Sql, props: GrantProps): Promise<DelegationRow | null> {
  if (typeof props.dlg !== "string" || typeof props.sub !== "string") return null;
  const rows = (await fresh.unsafe(
    `select * from app.actor_delegation($1::uuid)`,
    [props.dlg],
  )) as DelegationRow[];
  const d = rows[0];
  if (!d || d.state !== "active") return null;
  if (d.expires_at !== null && new Date(d.expires_at).getTime() <= Date.now()) return null;
  if (d.owner_user_id !== props.sub) return null;
  return d;
}
