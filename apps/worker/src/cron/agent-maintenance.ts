// apps/worker/src/cron/agent-maintenance.ts — the three */15 passes that run
// BEFORE drainDueSchedules so a stuck schedule cannot starve a cap it no
// longer needs (§10.15's index.ts order comment).
//
//   reapBridgeTasks          — 30-minute 'bridge_draft' holds  (§10.6.6)
//   sweepHeldReservations    — 6-hour general holds            (§10.7.2)
//   refreshConnectorTokens   — connector_credentials_expiry_idx (§10.8.1)
import {
  sealCredential,
  openCredential,
  makeGuardedFetch,
  hostsOf,
  type ConnectorManifest,
} from "@musebook/connectors";
import { pgFresh } from "../db.js";
import { audit } from "../lib/audit.js";

const BRIDGE_HOLD_MAX_AGE = "30 minutes";
const GENERAL_HOLD_MAX_AGE = "6 hours";
const TOKEN_REFRESH_WITHIN = "10 minutes";

/** The bridge reaper: a 'submitted' task whose far side never POSTed a result
 *  releases its hold and writes one agent.draft_failed row carrying the code —
 *  never agent text. */
export async function reapBridgeTasks(env: Env): Promise<void> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{ sweep_stale_holds: number }>(
      "select app.sweep_stale_holds($1::interval, $2::text, $3::text, $4::text)",
      [BRIDGE_HOLD_MAX_AGE, "bridge_draft", "bridge_task_expired", "bridge_task_expired"],
    );
    const reaped = rows[0]?.sweep_stale_holds ?? 0;
    if (reaped > 0) console.log("bridge_tasks_reaped", reaped);
  } finally {
    await db.end();
  }
}

/** The general sweeper: any 'held' reservation older than 6 h — a crashed
 *  draft, a dropped webhook, a dead isolate — releases so the cap frees. */
export async function sweepHeldReservations(env: Env): Promise<void> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{ sweep_stale_holds: number }>(
      "select app.sweep_stale_holds($1::interval)",
      [GENERAL_HOLD_MAX_AGE],
    );
    const released = rows[0]?.sweep_stale_holds ?? 0;
    if (released > 0) console.log("stale_holds_released", released);
  } finally {
    await db.end();
  }
}

/** OAuth access tokens expiring within TOKEN_REFRESH_WITHIN are refreshed via
 *  the connector's token endpoint, re-sealed under the same delegation subkey,
 *  and audited. A refresh failure releases nothing and is retried next tick —
 *  the credential simply keeps its expiry. */
export async function refreshConnectorTokens(env: Env): Promise<void> {
  const kek = kekBytes(env);
  if (!kek) return;

  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{
      id: string;
      delegation_id: string;
      kind: string;
      ciphertext: Buffer;
      key_id: string;
      expires_at: Date | string;
      manifest: ConnectorManifest;
    }>("select * from app.list_expiring_credentials($1::interval)", [
      TOKEN_REFRESH_WITHIN,
    ]);

    for (const row of rows) {
      if (row.kind !== "oauth_refresh") continue;
      try {
        const refreshToken = await openCredential(
          kek,
          row.delegation_id,
          new Uint8Array(row.ciphertext),
        );
        const refreshed = await exchangeRefreshToken(env, row.manifest, refreshToken);
        if (!refreshed) continue;

        const sealed = await sealCredential(
          kek,
          env.CONNECTOR_CRED_KEY_ID ?? row.key_id,
          row.delegation_id,
          refreshed.accessToken,
        );
        await db.query(
          "select app.store_connector_credential($1::uuid, $2::text, $3::bytea, $4::text, $5::timestamptz)",
          [
            row.delegation_id,
            "oauth_access",
            Buffer.from(sealed.ciphertext),
            sealed.keyId,
            refreshed.expiresAt?.toISOString() ?? null,
          ],
        );
        await audit(env, {
          action: "connector.token_refreshed",
          delegation_id: row.delegation_id,
          target_kind: "connector_credential",
          target_id: row.id,
        });
      } catch (e) {
        console.warn(
          "connector_token_refresh_failed",
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  } finally {
    await db.end();
  }
}

/** The refresh exchange: POST {grant_type: 'refresh_token'} to the manifest's
 *  first authorizationServer's /token endpoint through guardedFetch — the same
 *  egress allow-list and body cap a draft call rides. A non-2xx or a response
 *  without access_token is a skip, never a throw: the row stays on the expiry
 *  index and retries next tick. */
async function exchangeRefreshToken(
  env: Env,
  manifest: ConnectorManifest,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date | null } | null> {
  if (manifest.auth.kind !== "oauth2") return null;
  const server = manifest.auth.authorizationServers?.[0];
  if (!server) return null;

  const res = await makeGuardedFetch({
    allowHosts: hostsOf(manifest),
    totalTimeoutMs: Number(env.CONNECTOR_EGRESS_TIMEOUT_MS ?? 60_000),
    maxBytes: Number(env.CONNECTOR_EGRESS_MAX_BYTES ?? 8_388_608),
  })(new URL("/token", server).toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) return null;

  const body: {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  } = await res.json();
  if (!body.access_token) return null;
  return {
    accessToken: body.access_token,
    expiresAt:
      typeof body.expires_in === "number"
        ? new Date(Date.now() + body.expires_in * 1000)
        : null,
  };
}

function kekBytes(env: Env): Uint8Array | null {
  const raw = env.CONNECTOR_CRED_KEK;
  if (!raw) return null;
  return Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
}
