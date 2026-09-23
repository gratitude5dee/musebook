// apps/worker/test/agent-cancel.test.ts — §16.5 M9 item 9: Q_AGENT_CANCEL is
// bound and consumed. revoke_delegation enqueues one 'agent_cancel' outbox
// row per cancelled 'held' reservation; this drives runAgentCancel with that
// payload and asserts the far-side revoke fires and completes with an audit.
import { env } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { runAgentCancel } from "../src/consumers/agent-cancel.js";
import { resetSeed } from "./helpers/db.js";

const CONNECTOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const DELEGATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000099";
const AGENT_ID = "33333333-3333-4333-8333-000000000099";
const OWNER_ID = "11111111-1111-4111-8111-000000000003";
const ECHO_HOST = "seed-connector.musebook.dev";
const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

async function withAdminDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const MANIFEST = {
  manifestVersion: "2026-09-01",
  connectorId: "seed-echo-mcp",
  displayName: "Seed Echo MCP",
  vendor: "musebook",
  description: "Deterministic seeded connector for the cancel contract tests.",
  homepageUrl: `https://${ECHO_HOST}/`,
  transports: [{ kind: "mcp_http", url: `https://${ECHO_HOST}/mcp` }],
  capabilities: ["post.draft"],
  auth: { kind: "none" },
  limits: { postsPerDay: 10, maxDraftChars: 20000, maxEgressBytes: 1048576 },
};

let revokeCalls = 0;

beforeAll(async () => {
  await resetSeed();
  revokeCalls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(ECHO_HOST)) return new Response("not the connector", { status: 500 });
    revokeCalls += 1;
    return Response.json({ jsonrpc: "2.0", id: "mb-test", result: { ok: true } });
  });
  await withAdminDb(async (c) => {
    await c.query(
      `update public.connectors
          set manifest = $1::jsonb, transport = 'mcp_http',
              base_url = $2, auth_kind = 'none'
        where id = $3`,
      [MANIFEST as unknown as string, `https://${ECHO_HOST}/mcp`, CONNECTOR_ID],
    );
    await c.query(
      `delete from public.agent_spend_reservations
        where delegation_id = '${DELEGATION_ID}' and state = 'held'`,
    );
    await c.query(
      `insert into public.agent_identities (id, slug, display_name, owner_user_id, verification)
       values ($1, 'm9-cancel-agent', 'M9 Cancel Agent', $2, 'none')
       on conflict (id) do nothing`,
      [AGENT_ID, OWNER_ID],
    );
    await c.query(
      `insert into public.delegations
         (id, owner_user_id, connector_id, agent_identity_id, state, scopes,
          token_sha256, requires_approval)
       values ($1, $2, $3, $4, 'active', '{feed:read}'::text[],
               'd3c78a851c537955bff1e2c42d0f9e5c3bbd5a07e838c6c0b9da121609236172', false)
       on conflict (id) do update set state = 'active'`,
      [DELEGATION_ID, OWNER_ID, CONNECTOR_ID, AGENT_ID],
    );
  });
});

afterAll(async () => {
  // Leave the readonly delegation the way the acceptance suite expects it.
  await withAdminDb((c) =>
    c.query(`update public.delegations set state = 'active' where id = $1`, [DELEGATION_ID]),
  );
});

describe("M9.9 — Q_AGENT_CANCEL exists, is bound and is consumed", () => {
  it("a revoked delegation produces one message that runAgentCancel drains", async () => {
    // A live hold with a far-side ref — the only rows revoke_delegation
    // turns into cancel intents.
    const reservationId = await withAdminDb(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into public.agent_spend_reservations
           (delegation_id, window_start, purpose, estimate_atomic,
            external_kind, external_ref, idempotency_key, state)
         values ($1, now(), 'connector.call', 1000::numeric,
                 'mcp_tool', 'remote-42', $2, 'held')
         returning id`,
        [DELEGATION_ID, `m9-cancel-${crypto.randomUUID()}`],
      );
      return rows[0].id;
    });

    const enqueued = await withAdminDb(async (c) => {
      const { rows } = await c.query<{ revoke_delegation: number }>(
        `select public.revoke_delegation($1::uuid, 'm9 gate revoke', $2::uuid)`,
        [DELEGATION_ID, OWNER_ID],
      );
      return rows[0].revoke_delegation;
    });
    expect(enqueued).toBe(1);

    const msg = await withAdminDb(async (c) => {
      const { rows } = await c.query<{ payload: Record<string, unknown> }>(
        `select payload from public.job_outbox
          where kind = 'agent_cancel' and dedupe_key = $1`,
        [`cancel:${reservationId}`],
      );
      return rows[0]?.payload;
    });
    expect(msg).toBeTruthy();
    expect(msg!.reservation_id).toBe(reservationId);
    expect(msg!.delegation_id).toBe(DELEGATION_ID);

    const auditBefore = await withAdminDb(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text as n from public.audit_log
          where action = 'agent.cancel_completed' and target_id = $1`,
        [reservationId],
      );
      return Number(rows[0].n);
    });

    await runAgentCancel(env, msg as Record<string, unknown>);

    expect(revokeCalls).toBeGreaterThanOrEqual(1);
    const auditAfter = await withAdminDb(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text as n from public.audit_log
          where action = 'agent.cancel_completed' and target_id = $1`,
        [reservationId],
      );
      return Number(rows[0].n);
    });
    expect(auditAfter).toBe(auditBefore + 1);
  });
});
