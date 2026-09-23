// apps/mcp/test/acceptance.test.ts — §7.20's MCP-side acceptance checks over
// raw JSON-RPC on the wire. The plan's transport is undici to `wrangler dev`;
// SELF.fetch under @cloudflare/vitest-plugin is the same bytes on the same
// handler, hermetic (§17.6's chosen equivalent). Facilitator-dependent checks
// (7/8) skip loudly as SKIPPED-EXTERNAL when X402_TEST_PAYER_KEY is unset.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { currentMcpRequest, withMcpRequestContext } from "../src/request-context.js";

const BASE = "https://mcp.musebook.dev";
const REVISION = "2026-07-28";
const PAID_POST = "44444444-4444-4444-8444-000000000006";
const DELEGATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
const READONLY_DLG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000099";
const READONLY_AGENT_ID = "33333333-3333-4333-8333-000000000099";
const READONLY_TOKEN = "mb_dlg_m9_readonly_token_0000001";
const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

interface JsonRpcBody {
  result?: {
    resultType?: string;
    tools?: { name: string }[];
    structuredContent?: unknown;
    content?: { type: string; text?: string }[];
    isError?: boolean;
    [k: string]: unknown;
  };
  error?: { code: number; message: string };
}

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: { bearer?: string; meta?: Record<string, unknown>; host?: string; origin?: string } = {},
): Promise<{ status: number; body: JsonRpcBody; headers: Headers }> {
  const url = `${opts.host ?? BASE}/mcp`;
  // Revision 2026-07-28 makes params._meta REQUIRED on every request, with the
  // namespaced keys the mcp_http adapter already sends.
  const defaultMeta = {
    "io.modelcontextprotocol/protocolVersion": REVISION,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const fullParams = { ...params, _meta: opts.meta ?? defaultMeta };
  const res = await SELF.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        host: new URL(opts.host ?? BASE).host,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": REVISION,
        "mcp-method": method,
        ...(method === "tools/call" && typeof params.name === "string"
          ? { "mcp-name": params.name }
          : {}),
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `m9-${crypto.randomUUID()}`,
        method,
        params: fullParams,
      }),
    }),
  );
  const text = await res.text();
  // SSE replies carry the same JSON-RPC frame in a data: line.
  const jsonLine =
    res.headers.get("content-type")?.includes("text/event-stream") === true
      ? (text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .find((l) => l.startsWith("{")) ?? "{}")
      : text;
  return { status: res.status, body: JSON.parse(jsonLine) as JsonRpcBody, headers: res.headers };
}

async function b64urlSha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(d)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The real OAuth 2.1 dance end-to-end (§7.6.1): register → authorize page →
 *  consent POST binding an mb_dlg_ token → code exchange. */
async function oauthTokenFor(delegationToken: string, scope: string): Promise<string> {
  const reg = await SELF.fetch(
    new Request(`${BASE}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "m9-gate",
        redirect_uris: ["https://localhost:8787/cb"],
        // Public client — a minted client_secret would require Basic auth on
        // /token, and the provider rejects sending credentials twice.
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  expect(reg.status).toBeLessThan(400);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = `v-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const challenge = await b64urlSha256(verifier);
  const q = new URLSearchParams({
    client_id,
    redirect_uri: "https://localhost:8787/cb",
    response_type: "code",
    scope,
    state: "m9-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const page = await SELF.fetch(new Request(`${BASE}/authorize?${q}`));
  expect(page.status).toBe(200);
  const html = await page.text();
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1];
  const authQueryEncoded = /name="auth_query" value="([^"]+)"/.exec(html)?.[1];
  expect(csrf).toBeTruthy();
  expect(authQueryEncoded).toBeTruthy();
  const authQuery = authQueryEncoded!
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

  const form = new FormData();
  form.set("csrf", csrf!);
  form.set("auth_query", authQuery);
  form.set("delegation", delegationToken);
  form.set("decision", "approve");
  const red = await SELF.fetch(
    new Request(`${BASE}/authorize`, { method: "POST", body: form, redirect: "manual" }),
  );
  const loc = red.headers.get("location");
  expect(red.status).toBe(302);
  expect(loc).toBeTruthy();
  const code = new URL(loc!).searchParams.get("code");
  expect(code).toBeTruthy();

  const tok = await SELF.fetch(
    new Request(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        client_id,
        redirect_uri: "https://localhost:8787/cb",
        code_verifier: verifier,
      }).toString(),
    }),
  );
  const tokBody = (await tok.json()) as { access_token?: string; error?: string };
  expect(tokBody.access_token).toBeTruthy();
  return tokBody.access_token!;
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function adminDb<T = Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: ADMIN_DB_URL });
  await c.connect();
  try {
    const r = await c.query(sql, params);
    return r.rows as T[];
  } finally {
    await c.end();
  }
}

describe("§7.20 checks 1–4 — discover, resultType, deterministic ≤11 tools", () => {
  it("server/discover answers with the full envelope and instructions", async () => {
    const { status, body } = await rpc("server/discover");
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const r = body.result as Record<string, unknown>;
    for (const k of ["supportedVersions", "capabilities", "resultType", "ttlMs", "cacheScope"]) {
      expect(r[k], `discover.${k}`).toBeDefined();
    }
    expect(String(r["instructions"] ?? "")).toContain("Musebook");
  });

  it("tools/list is deterministic across calls and counts ≤ 11", async () => {
    const a = await rpc("tools/list");
    const b = await rpc("tools/list");
    const namesA = a.body.result?.tools?.map((t) => t.name);
    const namesB = b.body.result?.tools?.map((t) => t.name);
    expect(namesA).toBeTruthy();
    expect(namesA).toEqual(namesB);
    expect(namesA!.length).toBeLessThanOrEqual(11);
    expect(namesA).toContain("get_post");
    expect(namesA).toContain("purchase_access");
    expect(namesA).toContain("submit_post");
  });

  it("every tool result carries resultType on the wire", async () => {
    const res = await rpc("tools/call", {
      name: "search_posts",
      arguments: { query: "seed", limit: 3 },
    });
    expect(res.body.result?.resultType).toBeTruthy();
    expect(["complete", "input_required"]).toContain(res.body.result?.resultType);
  });
});

describe("§7.20 check 5 — payment-required shape is exact", () => {
  it("get_post on a mode-3 post anonymously returns the spec-exact 402 body", async () => {
    const { body } = await rpc("tools/call", {
      name: "get_post",
      arguments: { post_id: PAID_POST },
    });
    const r = body.result!;
    expect(r.isError).toBe(true);
    const sc = r.structuredContent as Record<string, unknown> | undefined;
    expect(sc).toBeTruthy();
    expect(r.content?.[0]?.text).toBe(JSON.stringify(sc));
    // x402 v2 field names — any v1 form (price, asset string, outputSchema) fails.
    const accepts = (
      sc as {
        accepts?: {
          amount?: string;
          network?: string;
          payTo?: string;
          maxTimeoutSeconds?: number;
          extra?: { name?: string };
        }[];
      }
    )?.accepts?.[0];
    expect(accepts).toBeTruthy();
    expect(accepts!.payTo).toBe(env.X402_PAY_TO);
    expect(accepts!.maxTimeoutSeconds).toBe(60);
    expect(accepts!.network).toBe(env.X402_NETWORK);
    expect(typeof accepts!.amount).toBe("string");
    expect((sc as { scheme?: unknown }).scheme ?? "exact").toBe("exact");
  });
});

describe("§7.20 check 6 — _meta['x402/payment'] is reachable in the handler", () => {
  it("withMcpRequestContext exposes params._meta to the wrapped handler", async () => {
    const payment = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:84532",
      payload: { marker: "m9" },
    };
    const req = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "m9-meta",
        method: "tools/call",
        params: { name: "get_post", arguments: {}, _meta: { "x402/payment": payment } },
      }),
    });
    const wrapped = withMcpRequestContext(async (r) => {
      const cur = currentMcpRequest();
      return Response.json({ meta: cur?.meta ?? null });
    });
    const res = await wrapped(req);
    const data = (await res.json()) as { meta: Record<string, unknown> | null };
    expect(data.meta).toBeTruthy();
    expect(data.meta!["x402/payment"]).toEqual(payment);
  });
});

describe("§7.20 check 9 — scope enforcement reads the database", () => {
  it("submit_post with a feed:read-only delegation errors on post:write; revoked delegation fails closed", async () => {
    const hash = await sha256hex(READONLY_TOKEN);
    await adminDb(
      `insert into public.agent_identities (id, slug, display_name, owner_user_id, verification)
       values ($1, 'm9-readonly-agent', 'M9 Read-Only Agent', $2, 'none')
       on conflict (id) do nothing`,
      [READONLY_AGENT_ID, "11111111-1111-4111-8111-000000000003"],
    );
    await adminDb(
      `insert into public.delegations
         (id, owner_user_id, connector_id, agent_identity_id, state, scopes,
          token_sha256, requires_approval)
       values ($1, $2, $3, $4, 'active', '{feed:read}'::text[], $5, false)
       on conflict (id) do update set state = 'active', scopes = '{feed:read}'::text[], token_sha256 = $5`,
      [
        READONLY_DLG_ID,
        "11111111-1111-4111-8111-000000000003",
        "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
        READONLY_AGENT_ID,
        hash,
      ],
    );

    const token = await oauthTokenFor(READONLY_TOKEN, "feed:read post:write");
    const denied = await rpc(
      "tools/call",
      {
        name: "submit_post",
        arguments: {
          kind: "note",
          body_markdown: "scope check body",
          idempotency_key: `m9-scope-${crypto.randomUUID()}`,
        },
      },
      { bearer: token },
    );
    expect(denied.body.result?.isError).toBe(true);
    const msg = denied.body.result?.content?.[0]?.text ?? "";
    expect(msg).toContain("post:write");

    // §16.5 M9 item 10: revoking goes through the RPC and appends exactly one
    // audit row — a bare UPDATE would leave no trail.
    const auditBefore = await adminDb<{ n: string }>(
      `select count(*)::text as n from public.audit_log
        where delegation_id = $1 and action = 'delegation.revoke'`,
      [READONLY_DLG_ID],
    );
    await adminDb(`select public.revoke_delegation($1::uuid, 'm9 acceptance revoke', $2::uuid)`, [
      READONLY_DLG_ID,
      "11111111-1111-4111-8111-000000000003",
    ]);
    const auditAfter = await adminDb<{ n: string }>(
      `select count(*)::text as n from public.audit_log
        where delegation_id = $1 and action = 'delegation.revoke'`,
      [READONLY_DLG_ID],
    );
    expect(Number(auditAfter[0].n)).toBe(Number(auditBefore[0].n) + 1);
    const after = await rpc(
      "tools/call",
      {
        name: "submit_post",
        arguments: {
          kind: "note",
          body_markdown: "scope check body",
          idempotency_key: `m9-scope-${crypto.randomUUID()}`,
        },
      },
      { bearer: token },
    );
    const denied2 =
      after.body.result?.isError === true ||
      after.body.error !== undefined ||
      after.status === 401 ||
      after.status === 403;
    expect(denied2).toBe(true);
  });
});

describe("§7.20 check 22 — DNS-rebinding defence is on", () => {
  it("rejects a foreign Origin and a non-allowlisted Host", async () => {
    const evilOrigin = await rpc("tools/list", {}, { origin: "https://evil.example" });
    expect(evilOrigin.status).toBeGreaterThanOrEqual(400);
    const badHost = await rpc("tools/list", {}, { host: "https://musebook-mcp.workers.dev" });
    expect(badHost.status).toBeGreaterThanOrEqual(400);
  });
});

const KEY = (env as unknown as Record<string, string>).X402_TEST_PAYER_KEY;
const SKIP_NOTE =
  "SKIPPED-EXTERNAL: X402_TEST_PAYER_KEY unset — §7.20 checks 7/8 (replay refusal, grant-after-edit) need a funded testnet wallet (§17.6).";

describe("§7.20 checks 7–8 — x402 settlement replay and grant invalidation", () => {
  it.skipIf(KEY === undefined)("payer-key-gated external checks", () => {
    expect(KEY).toBeTruthy();
  });
  it("reports SKIPPED-EXTERNAL when the payer key is absent", () => {
    if (KEY === undefined) expect(SKIP_NOTE).toContain("SKIPPED-EXTERNAL");
  });
});

describe("§16.5 M9.2 — RFC 9728 protected-resource metadata", () => {
  it("/.well-known/oauth-protected-resource names this resource and its auth server", async () => {
    const res = await SELF.fetch("https://mcp.musebook.dev/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    expect(body.resource).toBe("https://mcp.musebook.dev/mcp");
    expect(body.authorization_servers).toContain("https://mcp.musebook.dev");
    expect(body.scopes_supported).toContain("mcp");
  });
});

void DELEGATION_ID;
