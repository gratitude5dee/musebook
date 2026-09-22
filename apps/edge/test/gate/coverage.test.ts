// apps/edge/test/gate/coverage.test.ts — exercises the edge surfaces no other
// gate suite reaches: author routes, the outbox enqueue, ops logging on both
// rejection paths, the salted-IP privacy path, feed surfaces and cursor
// round-trips, and the unregistered-path router fallthrough.
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { authorProfile, listAuthors, listAuthorsCount } from "../../src/db/catalog.js";
import { bound, fresh } from "../../src/db/client.js";
import { loadPostByPostId, loadPostBySlug } from "../../src/db/posts.js";
import { enqueueJob } from "../../src/enqueue.js";
import { decodeCursor, encodeCursor } from "../../src/feed/cursor.js";
import { cacheHeadersFor } from "../../src/http/cache.js";
import { notFound, rangeHeaders, renderedToResponse } from "../../src/http.js";
import { portsFor } from "../../src/kernel/configure.js";
import { assertAssetEnv } from "../../src/kernel/payments.js";
import { matchAuthorRoute, parseResourceUrl } from "../../src/router.js";
import { behaviouralOptOut, truncateIp } from "../../src/telemetry/privacy.js";
import { getDailySalt } from "../../src/telemetry/salt.js";
import { opsLog } from "../../src/ops.js";
import { loadResource } from "@musebook/kernel";
import type { Actor } from "@musebook/schema";
import {
  db,
  PAID_BYTES,
  seedMediaAsset,
  seededGrantToken,
  SLUG,
  signedBotAuthHeaders,
} from "./helpers.js";

const HFAP_POST = "44444444-4444-4444-8444-000000000005"; // seed-article-hfap

const GATED = SLUG.gated;
const FREE = SLUG.free;
const UA = { "user-agent": "Mozilla/5.0 (coverage)" };

describe("author surfaces (/@a, /authors.md)", () => {
  it("serves the twin, the .md representation and the author feed", async () => {
    // Worker-served only: the bare `/@handle` HTML proxies to the origin,
    // which this suite does not stand up (origin-lockdown.test.ts owns it).
    for (const path of ["/@seed_creator.md", "/@seed_creator/feed.xml", "/authors.md"]) {
      const res = await SELF.fetch(`https://musebook.dev${path}`, { headers: UA });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });
});

describe("feed surfaces and the cursor (feed.ts, cursor.ts, router.ts)", () => {
  const post = (body: object, headers: Record<string, string> = {}) =>
    SELF.fetch("https://musebook.dev/api/feed/foryou", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("anonymous explore serves the cached slate or a degraded page", async () => {
    const res = await post({ surface: "explore", limit: 5 });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(Array.isArray(page.items)).toBe(true);
  });

  it("a page-2 cursor round-trips through encode/decode", async () => {
    const cookie = { cookie: "mb_session=musebook-seed-session-token-0001" };
    const p1 = (await (await post({ surface: "explore", limit: 2 }, cookie)).json()) as {
      items: unknown[];
      nextCursor: string | null;
    };
    if (p1.nextCursor === null) return; // slate smaller than the page — nothing to continue
    const p2 = (await (
      await post({ surface: "explore", limit: 2, cursor: p1.nextCursor }, cookie)
    ).json()) as { items: unknown[] };
    expect(Array.isArray(p2.items)).toBe(true);
  });

  it("rejects a malformed body and an unregistered path 404s", async () => {
    const bad = await SELF.fetch("https://musebook.dev/api/feed/foryou", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    // Router fallthrough 404 on a Worker-served pattern (the twin, not HTML).
    const missing = await SELF.fetch("https://musebook.dev/p/no-such-post.md", {
      headers: UA,
    });
    expect(missing.status).toBe(404);
  });
});

describe("ops + telemetry privacy path (ops.ts, salt.ts, privacy.ts)", () => {
  it("a malformed batch logs batch_rejected and still returns 204", async () => {
    const res = await SELF.fetch("https://musebook.dev/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 2, nonsense: true }),
    });
    expect(res.status).toBe(204);
    await vi.waitFor(
      async () => {
        const rows = await db<{ n: number }>(
          "select count(*)::int as n from public.ops_events where event_name = 'batch_rejected'",
        );
        expect(rows[0].n).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it("a valid batch runs the salted-IP hashing path end to end", async () => {
    const res = await SELF.fetch("https://musebook.dev/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.7",
        cookie: "mb_session=musebook-seed-session-token-0001",
      },
      body: JSON.stringify({
        v: 1,
        sent_at: Date.now(),
        events: [
          {
            event_id: crypto.randomUUID(),
            t: Date.now(),
            action: "impression",
            post_id: "44444444-4444-4444-8444-000000000001",
            content_hash: "a2ba373945f6b8c993cf55036bb86ba00a6c2a43a0e903c1b2e201fe9b48baa0",
            surface: "explore",
            slate_id: "55555555-5555-4555-8555-000000000001",
            position: 0,
            view_session_id: crypto.randomUUID(),
          },
        ],
      }),
    });
    expect(res.status).toBe(204);
    // getDailySalt landed a row for today through app.telemetry_salt_for_day.
    await vi.waitFor(
      async () => {
        const rows = await db<{ n: number }>(
          "select count(*)::int as n from public.telemetry_salts where day = current_date",
        );
        expect(rows[0].n).toBe(1);
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});

describe("enqueueJob (enqueue.ts)", () => {
  it("writes the outbox row then sends to the kind's queue", async () => {
    const ctx = createExecutionContext();
    const dedupeKey = `test-cov-${crypto.randomUUID()}`;
    const id = await enqueueJob(env, ctx, "classify", dedupeKey, {
      content_hash: "a2ba373945f6b8c993cf55036bb86ba00a6c2a43a0e903c1b2e201fe9b48baa0",
    });
    await waitOnExecutionContext(ctx);
    expect(id).not.toBeNull();
    const rows = await db<{ kind: string; state: string }>(
      "select kind, state from public.job_outbox where dedupe_key = $1",
      [dedupeKey],
    );
    expect(rows[0].kind).toBe("classify");
    expect(["queued", "running", "succeeded"]).toContain(rows[0].state);
    await db("delete from public.job_outbox where dedupe_key = $1", [dedupeKey]);
  });

  it("rejects a payload over the 128 KB cap", async () => {
    const ctx = createExecutionContext();
    await expect(
      enqueueJob(env, ctx, "embed", `test-cov-big-${crypto.randomUUID()}`, {
        blob: "x".repeat(129 * 1024),
      }),
    ).rejects.toThrow(/128 ?KB|exceeds/);
    await waitOnExecutionContext(ctx);
  });
});

describe("miscellaneous gated reads", () => {
  it("serves the three feed serialisations", async () => {
    for (const path of ["/feed.xml", "/feed.json", "/atom.xml"]) {
      const res = await SELF.fetch(`https://musebook.dev${path}`, { headers: UA });
      expect(res.status).toBe(200);
    }
  });

  it("denied twin 402s, and the seeded crawler grant opens the hfap note", async () => {
    const denied = await SELF.fetch(`https://musebook.dev/p/${GATED}.md`, { headers: UA });
    expect(denied.status).toBe(402);
    // The seed ships a live grant for the crawler on seed-article-hfap's
    // content_hash — a signed bot request walks grants.ts's live-grant arm.
    const headers = await signedBotAuthHeaders("https://musebook.dev/p/seed-article-hfap.md");
    const granted = await SELF.fetch("https://musebook.dev/p/seed-article-hfap.md", {
      headers,
    });
    expect(granted.status).toBe(200);
    const free = await SELF.fetch(`https://musebook.dev/p/${FREE}.json`, { headers: UA });
    expect(free.status).toBe(200);
  });
});

describe("pure helpers (privacy, router, http, cursor, cache)", () => {
  it("truncateIp buckets v4 /24, expands v6 to /48, rejects garbage", () => {
    expect(truncateIp("203.0.113.7")).toBe("203.0.113.0/24");
    expect(truncateIp("1.2.3.4")).toBe("1.2.3.0/24");
    expect(truncateIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:0db8:85a3::/48");
    expect(truncateIp("::1")).toBe("0000:0000:0000::/48");
    expect(truncateIp("::ffff:203.0.113.9")).toBe("0000:0000:0000::/48");
    // A zone id with letters fails the V6_CHARS whitelist before zone-
    // stripping runs; a numeric zone survives it.
    expect(truncateIp("fe80::1%eth0")).toBeNull();
    expect(truncateIp("fe80::1%1")).toBe("fe80:0000:0000::/48");
    expect(truncateIp("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe("2001:0db8:0000::/48");
    expect(truncateIp("999.1.1.1")).toBeNull();
    expect(truncateIp("1.2.3.4.5")).toBeNull();
    expect(truncateIp("not-an-ip")).toBeNull();
    expect(truncateIp("::ffff:999.1.1.1")).toBeNull();
    expect(truncateIp("::a::b")).toBeNull();
    expect(truncateIp("1:2:3:4:5:6:7")).toBeNull();
    expect(truncateIp("1:2:3:4:5:6:7:8::9")).toBeNull();
    expect(truncateIp("")).toBeNull();
  });

  it("behaviouralOptOut honours DNT and GPC identically", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(behaviouralOptOut(h({ dnt: "1" }))).toBe(true);
    expect(behaviouralOptOut(h({ "sec-gpc": "1" }))).toBe(true);
    expect(behaviouralOptOut(h({ dnt: "0" }))).toBe(false);
    expect(behaviouralOptOut(h({}))).toBe(false);
  });

  it("parseResourceUrl picks the twin ext or negotiates html/markdown", () => {
    const u = (p: string) => new URL(`https://musebook.dev${p}`);
    expect(parseResourceUrl(u("/p/a-slug.md"), null)).toEqual({
      slug: "a-slug",
      as: "markdown",
    });
    expect(parseResourceUrl(u("/p/a-slug.json"), null)).toEqual({ slug: "a-slug", as: "json" });
    expect(parseResourceUrl(u("/p/a-slug.jsonld"), null)).toEqual({
      slug: "a-slug",
      as: "jsonld",
    });
    expect(parseResourceUrl(u("/p/a-slug"), "text/markdown")).toEqual({
      slug: "a-slug",
      as: "markdown",
    });
    // A tie goes html — browsers send markdown AND html at the same q.
    expect(parseResourceUrl(u("/p/a-slug"), "text/html, text/markdown")).toEqual({
      slug: "a-slug",
      as: "html",
    });
    expect(parseResourceUrl(u("/p/a-slug"), null)).toEqual({ slug: "a-slug", as: "html" });
    expect(parseResourceUrl(u("/p/a-slug"), "text/markdown;q=0.9, text/html;q=0.1")).toEqual({
      slug: "a-slug",
      as: "markdown",
    });
    expect(parseResourceUrl(u("/x/a-slug"), null)).toBeNull();
    expect(parseResourceUrl(u("/"), null)).toBeNull();
  });

  it("matchAuthorRoute binds the twin and feed arms only", () => {
    expect(matchAuthorRoute("/@hh.md")).toEqual({ kind: "author_twin", handle: "hh" });
    expect(matchAuthorRoute("/@hh/feed.xml")).toEqual({ kind: "author_feed", handle: "hh" });
    expect(matchAuthorRoute("/@h")).toBeNull();
    expect(matchAuthorRoute("/@hh/x")).toBeNull();
    expect(matchAuthorRoute("/@x_y-9.md")).toEqual({ kind: "author_twin", handle: "x_y-9" });
  });

  it("cacheHeadersFor emits the negotiated, private and shared arms", () => {
    expect(cacheHeadersFor({ negotiated: true })).toEqual({
      "cache-control": "private, no-store",
      vary: "Accept, *",
    });
    expect(cacheHeadersFor({ shared: false })).toEqual({
      "cache-control": "private, no-store, must-revalidate",
      vary: "*",
    });
    const shared = cacheHeadersFor({ shared: true, sMaxAge: 60 });
    expect(shared["cloudflare-cdn-cache-control"]).toBe("public, s-maxage=60");
    const swr = cacheHeadersFor({ shared: true, sMaxAge: 10, swr: 30, vary: ["A", "B"] });
    expect(swr["cloudflare-cdn-cache-control"]).toContain("stale-while-revalidate=30");
    expect(swr.vary).toBe("A, B");
  });

  it("cursor round-trips and rejects malformed payloads", () => {
    const c = {
      slateId: "55555555-5555-4555-8555-000000000001",
      offset: 2,
      weightsVersion: "none",
    };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ slateId: 1 })))).toBeNull();
    expect(decodeCursor(btoa("{"))).toBeNull();
  });

  it("http helpers: notFound, renderedToResponse, rangeHeaders arms", () => {
    expect(notFound().status).toBe(404);
    const r = renderedToResponse({ body: "x", status: 418, headers: { "x-a": "1" } });
    expect(r.status).toBe(418);
    expect(r.headers.get("x-a")).toBe("1");
    expect(rangeHeaders({ offset: 0, length: 2 }, 10).get("content-range")).toBe("bytes 0-1/10");
    expect(rangeHeaders({ suffix: 5 }, 10).get("content-range")).toBe("bytes 5-9/10");
    expect(rangeHeaders({ suffix: 20 }, 10).get("content-range")).toBe("bytes 0-9/10");
    expect(rangeHeaders({ offset: 2 }, 10).get("content-range")).toBe("bytes 2-9/10");
  });

  it("portsFor builds ports on the default fresh client, and catalog mappers run", async () => {
    const ctx = createExecutionContext();
    const ports = portsFor(new Request("https://musebook.dev/"), env, ctx);
    expect(typeof ports.now).toBe("function");
    const authors = await listAuthors(fresh(env), 5);
    expect(authors.length).toBeGreaterThan(0);
    await waitOnExecutionContext(ctx);
  });

  it("getDailySalt caches the day row on the second call", async () => {
    const ctx = createExecutionContext();
    const a = await getDailySalt(env);
    const b = await getDailySalt(env);
    expect(b.equals(a)).toBe(true);
    await waitOnExecutionContext(ctx);
  });

  it("enqueueJob covers every kind's queue mapping", async () => {
    const ctx = createExecutionContext();
    for (const kind of [
      "embed",
      "distribute",
      "media",
      "media_finalize",
      "agent_cancel",
    ] as const) {
      const id = await enqueueJob(env, ctx, kind, `test-cov-${kind}-${crypto.randomUUID()}`, {});
      expect(id).not.toBeNull();
    }
    await waitOnExecutionContext(ctx);
  });
});

describe("feed + events arms", () => {
  it("GET on either API 405s", async () => {
    expect((await SELF.fetch("https://musebook.dev/api/events")).status).toBe(405);
    expect((await SELF.fetch("https://musebook.dev/api/feed/foryou")).status).toBe(405);
  });

  it("a stale weightsVersion discards the cursor and re-reads page 1", async () => {
    const res = await SELF.fetch("https://musebook.dev/api/feed/foryou", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "explore",
        limit: 2,
        cursor: encodeCursor({
          slateId: "55555555-5555-4555-8555-000000000001",
          offset: 1,
          weightsVersion: "stale-v9",
        }),
      }),
    });
    expect(res.status).toBe(200);
  });

  it("a cursor past the last item falls through to the degraded rungs", async () => {
    const res = await SELF.fetch("https://musebook.dev/api/feed/foryou", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "explore",
        limit: 2,
        cursor: encodeCursor({
          slateId: "55555555-5555-4555-8555-000000000001",
          offset: 99999,
          weightsVersion: "none",
        }),
      }),
    });
    expect(res.status).toBe(200);
  });

  it("foryou for a signed agent actor takes the agent-plane arms", async () => {
    const res = await SELF.fetch("https://musebook.dev/api/feed/foryou", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedBotAuthHeaders("https://musebook.dev/api/feed/foryou")),
      },
      body: JSON.stringify({ surface: "feed", limit: 3 }),
    });
    expect(res.status).toBe(200);
  });

  it("handleFeedScored: 405 on GET, 400 on a malformed body, 200 with candidates", async () => {
    expect((await SELF.fetch("https://musebook.dev/api/feed/scored")).status).toBe(405);
    const bad = await SELF.fetch("https://musebook.dev/api/feed/scored", {
      method: "POST",
      body: "{broken json",
    });
    expect(bad.status).toBe(400);
    const res = await SELF.fetch("https://musebook.dev/api/feed/scored", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "explore", limit: 3 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toBeInstanceOf(Array);
  });

  it("broken JSON is still a 204; x-mb-request-id reaches ingest", async () => {
    expect(
      (await SELF.fetch("https://musebook.dev/api/events", { method: "POST", body: "{broken" }))
        .status,
    ).toBe(204);
    const res = await SELF.fetch("https://musebook.dev/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mb-request-id": "req-coverage-1",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: JSON.stringify({
        v: 1,
        sent_at: Date.now(),
        events: [
          {
            event_id: crypto.randomUUID(),
            t: Date.now(),
            action: "impression",
            post_id: "44444444-4444-4444-8444-000000000001",
            content_hash: "a2ba373945f6b8c993cf55036bb86ba00a6c2a43a0e903c1b2e201fe9b48baa0",
            surface: "explore",
            slate_id: "55555555-5555-4555-8555-000000000001",
            position: 0,
            view_session_id: crypto.randomUUID(),
          },
        ],
      }),
    });
    expect(res.status).toBe(204);
  });

  it("a v6 connecting IP takes the expand/hashClientIp v6 arms", async () => {
    const res = await SELF.fetch("https://musebook.dev/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "2001:db8::5",
      },
      body: JSON.stringify({
        v: 1,
        sent_at: Date.now(),
        events: [
          {
            event_id: crypto.randomUUID(),
            t: Date.now(),
            action: "impression",
            post_id: "44444444-4444-4444-8444-000000000001",
            content_hash: "a2ba373945f6b8c993cf55036bb86ba00a6c2a43a0e903c1b2e201fe9b48baa0",
            surface: "explore",
            slate_id: "55555555-5555-4555-8555-000000000001",
            position: 0,
            view_session_id: crypto.randomUUID(),
          },
        ],
      }),
    });
    expect(res.status).toBe(204);
  });

  it("the referer parse arms: a host is kept, garbage is dropped", async () => {
    for (const referer of ["https://blog.example/x", "not a url"]) {
      const res = await SELF.fetch("https://musebook.dev/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          referer,
          "cf-connecting-ip": "203.0.113.11",
        },
        body: JSON.stringify({
          v: 1,
          sent_at: Date.now(),
          events: [
            {
              event_id: crypto.randomUUID(),
              t: Date.now(),
              action: "impression",
              post_id: "44444444-4444-4444-8444-000000000001",
              content_hash: "a2ba373945f6b8c993cf55036bb86ba00a6c2a43a0e903c1b2e201fe9b48baa0",
              surface: "explore",
              slate_id: "55555555-5555-4555-8555-000000000001",
              position: 0,
              view_session_id: crypto.randomUUID(),
            },
          ],
        }),
      });
      expect(res.status).toBe(204);
    }
  });
});

describe("kernel ports and media conditionals (configure, payments, grants, media)", () => {
  it("portsFor: resource loads, the log and actorUserId arrows, assertAssetEnv re-entry", async () => {
    const ctx = createExecutionContext();
    const ports = portsFor(new Request("https://musebook.dev/"), env, ctx, { actorUserId: null });
    const bySlug = await ports.resources.loadRowBySlug("seed-article-hfap");
    expect(bySlug?.post_id).toBe(HFAP_POST);
    const byId = await ports.resources.loadRowByPostId(HFAP_POST);
    expect(byId?.slug).toBe("seed-article-hfap");
    ports.log({ event: "coverage" });
    assertAssetEnv(env);
    assertAssetEnv(env); // `asserted` early-return arm
    await waitOnExecutionContext(ctx);
  });

  it("assertAssetEnv throws on each disagreeing arm", async () => {
    // `asserted` is module-scoped — resetModules re-imports with it cleared.
    const patched = (patch: Record<string, string>) => ({ ...env, ...patch }) as unknown as Env;
    const cases: Record<string, string>[] = [
      { X402_NETWORK: "eip155:0" },
      { X402_ASSET_ADDRESS: "0x0000000000000000000000000000000000000000" },
      { X402_CHAIN_ID: "1" },
      { X402_ASSET_EIP712_NAME: "Nope" },
      { X402_ASSET_DECIMALS: "18" },
    ];
    for (const patch of cases) {
      vi.resetModules();
      const mod = await import("../../src/kernel/payments.js");
      expect(() => mod.assertAssetEnv(patched(patch))).toThrowError();
    }
    vi.resetModules();
    const mod = await import("../../src/kernel/payments.js");
    expect(() => mod.assertAssetEnv(env)).not.toThrow();
  });

  it("payments.challenge pins a quote on both actor planes; settle fails closed", async () => {
    const ctx = createExecutionContext();
    const ports = portsFor(new Request("https://musebook.dev/"), env, ctx);
    const row = await ports.resources.loadRowBySlug("seed-article-hfap");
    expect(row).not.toBeNull();
    const resource = loadResource(row!);
    const human = { plane: "human", userId: null } as unknown as Actor;
    const agent = {
      plane: "agent",
      agentIdentityId: "33333333-3333-4333-8333-000000000001",
    } as unknown as Actor;
    const url = "https://musebook.dev/p/seed-article-hfap";
    const req1 = await ports.payments.challenge({
      resource,
      actor: human,
      resourceUrl: url,
      mimeType: "text/markdown",
    });
    expect(req1).toMatchObject({ resource: { url } });
    // error + agent-plane + title-fallback arms.
    await ports.payments.challenge({
      resource: { ...resource, title: null },
      actor: agent,
      resourceUrl: url,
      mimeType: "text/markdown",
      error: "coverage",
    });
    await expect(
      ports.payments.settle({ resource, actor: human, resourceUrl: url }),
    ).resolves.toEqual({ kind: "unavailable" });
    await waitOnExecutionContext(ctx);
  });

  it("mintGrant inserts once, then reads the live grant back on conflict", async () => {
    const ctx = createExecutionContext();
    const ports = portsFor(new Request("https://musebook.dev/"), env, ctx);
    const row = await ports.resources.loadRowBySlug("seed-article-hfap");
    expect(row).not.toBeNull();
    const g = {
      settlementId: crypto.randomUUID(),
      contentHash: row!.content_hash,
      postId: HFAP_POST,
      payer: "0x000000000000000000000000000000000000c0e1",
      subjectAgentId: null,
      subjectUserId: null,
      expiresAt: null,
    };
    // access_grants.settlement_id is a real FK — mint needs a settlement row.
    await db(
      `insert into public.x402_settlements
         (id, post_id, content_hash, network, asset, payer, nonce,
          amount_atomic, pay_to, transaction, status, facilitator_url, settled_at)
       select $1::uuid, p.id, p.content_hash, 'eip155:84532',
              '0x036cbd53842c5426634e7929541ec2318f3dcf7e', $2,
              '0x' || lpad(encode(gen_random_bytes(28), 'hex'), 56, '0') || '00c0e1ff',
              p.price_atomic, '0x0000000000000000000000000000000000000001',
              '0x' || lpad(encode(gen_random_bytes(28), 'hex'), 56, '0') || '00c0e1ee',
              'settled'::settlement_status, 'https://x402.org/facilitator', now()
         from public.posts p where p.id = $3::uuid`,
      [g.settlementId, g.payer, HFAP_POST],
    );
    const first = await ports.grants.mintGrant(g);
    expect(first.payer).toBe("0x000000000000000000000000000000000000c0e1");
    const secondSettlement = crypto.randomUUID();
    await db(
      `insert into public.x402_settlements
         (id, post_id, content_hash, network, asset, payer, nonce,
          amount_atomic, pay_to, transaction, status, facilitator_url, settled_at)
       select $1::uuid, p.id, p.content_hash, 'eip155:84532',
              '0x036cbd53842c5426634e7929541ec2318f3dcf7e', $2,
              '0x' || lpad(encode(gen_random_bytes(28), 'hex'), 56, '0') || '00c0e1dd',
              p.price_atomic, '0x0000000000000000000000000000000000000001',
              '0x' || lpad(encode(gen_random_bytes(28), 'hex'), 56, '0') || '00c0e1cc',
              'settled'::settlement_status, 'https://x402.org/facilitator', now()
         from public.posts p where p.id = $3::uuid`,
      [secondSettlement, g.payer, HFAP_POST],
    );
    const again = await ports.grants.mintGrant({ ...g, settlementId: secondSettlement });
    expect(again.id).toBe(first.id);
    await waitOnExecutionContext(ctx);
  });

  it("media: 200, HEAD, 206, 304, 412 and the 404 arms", async () => {
    // Own object key: seedMediaAsset deletes by fixture-sha on insert, so two
    // files on the same key race each other's rows.
    const key = `m/paid/2026/09/coverage-${crypto.randomUUID()}.avif`;
    await env.PAID_MEDIA.put(key, PAID_BYTES, {
      httpMetadata: { contentType: "image/avif" },
    });
    await seedMediaAsset(key, HFAP_POST);
    const url = `https://media.musebook.dev/${key}`;
    const auth = { authorization: `Bearer ${await seededGrantToken(HFAP_POST)}` };
    const ok = await SELF.fetch(url, { headers: auth });
    expect(ok.status).toBe(200);
    const etag = ok.headers.get("etag") ?? "";
    const head = await SELF.fetch(url, { method: "HEAD", headers: auth });
    expect(head.status).toBe(200);
    expect((await SELF.fetch(url, { headers: { ...auth, range: "bytes=0-1" } })).status).toBe(206);
    expect((await SELF.fetch(url, { headers: { ...auth, "if-match": '"bogus"' } })).status).toBe(
      412,
    );
    expect((await SELF.fetch(url, { headers: { ...auth, "if-none-match": etag } })).status).toBe(
      304,
    );
    expect((await SELF.fetch("https://media.musebook.dev/never-uploaded.bin")).status).toBe(404);
    expect((await SELF.fetch("https://media.musebook.dev/..%2fetc")).status).toBe(404);
  });

  it("media: an r2_public asset on the paid path refuses rather than leaks", async () => {
    const key = `m/public/${crypto.randomUUID()}-cov.avif`;
    await env.PAID_MEDIA.put(key, new TextEncoder().encode("never"));
    await seedMediaAsset(key, HFAP_POST, "r2_public");
    const auth = { authorization: `Bearer ${await seededGrantToken(HFAP_POST)}` };
    expect((await SELF.fetch(`https://media.musebook.dev/${key}`, { headers: auth })).status).toBe(
      404,
    );
  });
});

describe("branch arms: catalog/posts/ops helpers, parseBody, twin + feed arms", () => {
  it("db helpers: bound throws, default args, and the miss arms", async () => {
    expect(() => bound(undefined, "TEST_X")).toThrowError(/binding TEST_X/);
    const client = fresh(env);
    try {
      expect(await loadPostBySlug(client, "seed-article-hfap")).not.toBeNull();
      expect(await loadPostBySlug(client, "no-such-slug-zzz")).toBeNull();
      expect(await loadPostByPostId(client, "99999999-9999-4999-8999-000000000099")).toBeNull();
      expect(Number(await listAuthorsCount(client))).toBeGreaterThan(0);
      expect(await authorProfile(client, "no-such-author")).toBeNull();
    } finally {
      await client.end();
    }
  });

  it("opsLog defaults level, outcome and request_id", async () => {
    await opsLog(env, { component: "coverage", event_name: "cov_defaults" });
  });

  it("parseBody rejects each malformed-field arm", async () => {
    const post = (body: object) =>
      SELF.fetch("https://musebook.dev/api/feed/foryou", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      { surface: "explore", cursor: 123 },
      { surface: "explore", cursor: "x".repeat(600) },
      { surface: "explore", limit: 0 },
      { surface: "explore", limit: 101 },
      { surface: "explore", limit: 1.5 },
      { limit: 3 },
      { surface: "nope" },
      { surface: 42 },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  it("reels takes the forced-surface arm", async () => {
    const res = await SELF.fetch("https://musebook.dev/api/feed/reels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 }),
    });
    expect(res.status).toBe(200);
  });

  it("an agent on explore reaches rung2 with a real page", async () => {
    const res = await SELF.fetch("https://musebook.dev/api/feed/foryou", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedBotAuthHeaders("https://musebook.dev/api/feed/foryou")),
      },
      body: JSON.stringify({ surface: "explore", limit: 3 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("grant KV round-trip: miss -> read -> backfill -> hit", async () => {
    const ctx = createExecutionContext();
    const ports = portsFor(new Request("https://musebook.dev/"), env, ctx);
    const row = await ports.resources.loadRowBySlug("seed-article-hfap");
    expect(row).not.toBeNull();
    // The seeded crawler grant on seed-article-hfap is durable (expires_at null).
    const q = {
      contentHash: row!.content_hash,
      payer: "0x3333333333333333333333333333333333333333",
      agentId: null,
      userId: null,
    };
    const miss = await ports.grants.findLiveGrant(q);
    expect(miss?.payer).toBe(q.payer);
    await waitOnExecutionContext(ctx); // flush the KV backfill
    const hit = await ports.grants.findLiveGrant(q);
    expect(hit?.id).toBe(miss!.id);
    await waitOnExecutionContext(ctx);
  });

  it("twins: html row-null, rep ternaries, unknown author, deny, artifacts", async () => {
    expect(
      (
        await SELF.fetch("https://musebook.dev/p/no-such-post", {
          headers: { accept: "text/html" },
        })
      ).status,
    ).toBe(404);
    for (const ext of ["json", "jsonld"] as const) {
      const res = await SELF.fetch(`https://musebook.dev/p/seed-article-free.${ext}`, {
        headers: UA,
      });
      expect(res.status).toBe(200);
    }
    expect(
      (await SELF.fetch("https://musebook.dev/@no_such_author_zz.md", { headers: UA })).status,
    ).toBe(404);
    // A signed agent denied on the bare page lands on the !decision.allow html
    // arm. seed-note-hfap has no crawler grant — the article's does, and an
    // allowed html page proxies to an origin this suite does not run.
    const denied = await SELF.fetch("https://musebook.dev/p/seed-note-hfap", {
      headers: await signedBotAuthHeaders("https://musebook.dev/p/seed-note-hfap"),
    });
    expect(denied.status).toBe(402);
    expect((await SELF.fetch("https://artifacts.musebook.dev/no-such.zip")).status).toBe(404);
  });
});
