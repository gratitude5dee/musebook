// apps/worker/test/agent-draft.test.ts — §16.5 M9 item 6: a 'manual' schedule
// fired by next_run_at = now() yields one pending_approval post and one
// settled reservation. The connector is the seeded 'seed-echo-mcp' manifest
// (updated here to a valid drafting manifest); the far side is a stubbed
// fetch answering the mcp_http draft_post JSON-RPC — guardedFetch's
// allowlist passes because the manifest's transport URL is the stubbed host.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { drainDueSchedules } from "../src/cron/agent-draft.js";
import { withDb, resetSeed } from "./helpers/db.js";

const CONNECTOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const DELEGATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
const SCHEDULE_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
const ECHO_HOST = "seed-connector.musebook.dev";

const DRAFTING_MANIFEST = {
  manifestVersion: "2026-09-01",
  connectorId: "seed-echo-mcp",
  displayName: "Seed Echo MCP",
  vendor: "musebook",
  description: "Deterministic seeded connector for the drafting contract tests.",
  homepageUrl: "https://seed-connector.musebook.dev/",
  iconUrl: "https://seed-connector.musebook.dev/icon.png",
  supportEmail: "ops@seed-connector.musebook.dev",
  transports: [{ kind: "mcp_http", url: `https://${ECHO_HOST}/mcp` }],
  capabilities: ["post.draft"],
  auth: { kind: "none" },
  limits: { postsPerDay: 10, maxDraftChars: 20000, maxEgressBytes: 1048576 },
};

const DRAFT_BODY =
  "Seed agent draft — a deterministic paragraph the gate asserts lands pending_approval.";

function stubConnectorFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(ECHO_HOST)) {
      return new Response("not the connector", { status: 500 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string;
      params?: { name?: string };
    };
    if (body.method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id: "mb-test",
        result: {
          resultType: "complete",
          content: [{ type: "text", text: DRAFT_BODY }],
          structuredContent: {
            text: DRAFT_BODY,
            hashtags: ["seed", "m9"],
            modelUsed: "seed-echo-1",
            costAtomic: "42000",
          },
        },
      });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: "mb-test",
      result: { resultType: "complete", structuredContent: { tools: [{ name: "draft_post" }] } },
    });
  });
}

beforeAll(async () => {
  await resetSeed();
  await withDb(async (c) => {
    await c.query(
      `update public.connectors
          set manifest = $1::jsonb, transport = 'mcp_http',
              base_url = $2, auth_kind = 'none'
        where id = $3`,
      [DRAFTING_MANIFEST as unknown as string, `https://${ECHO_HOST}/mcp`, CONNECTOR_ID],
    );
    await c.query(
      `insert into public.agent_post_schedules
         (id, delegation_id, cadence, prompt_template, target_platforms,
          max_posts_per_day, approval_mode, approval_n, next_run_at, last_run_at, enabled)
       values ($1, $2, 'manual', 'seed prompt for {handle} on {today}', '{}',
               3, 'always', null, now(), now() - interval '1 minute', true)
       on conflict (id) do update set next_run_at = excluded.next_run_at, enabled = true`,
      [SCHEDULE_ID, DELEGATION_ID],
    );
  });
  stubConnectorFetch();
});

describe("M9.6 — manual schedule drain", () => {
  it("a 'manual' schedule fired by next_run_at=now() yields one pending_approval post and one settled reservation", async () => {
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        void p;
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    await drainDueSchedules(env, ctx);

    const found = await withDb(async (c) => {
      const posts = await c.query<{ id: string; status: string }>(
        `select id, status from public.posts
          where posted_by_agent_id = '33333333-3333-4333-8333-000000000001'
            and status = 'pending_approval'
          order by created_at desc limit 5`,
      );
      const approvals = await c.query<{ id: string }>(
        `select id from public.approval_queue
          where payload->>'postId' = any($1::text[]) and state = 'pending'`,
        [posts.rows.map((p) => p.id)],
      );
      const reservations = await c.query<{ id: string; state: string; actual_atomic: string }>(
        `select id, state, actual_atomic from public.agent_spend_reservations
          where delegation_id = $1 and state = 'settled'
          order by created_at desc limit 5`,
        [DELEGATION_ID],
      );
      return { posts: posts.rows, approvals: approvals.rows, reservations: reservations.rows };
    });

    expect(found.posts.length).toBeGreaterThanOrEqual(1);
    expect(found.approvals.length).toBeGreaterThanOrEqual(1);
    expect(found.reservations.length).toBeGreaterThanOrEqual(1);
    expect(BigInt(found.reservations[0]!.actual_atomic)).toBeGreaterThanOrEqual(0n);
  });
});
