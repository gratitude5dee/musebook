// apps/edge/test/gate/coverage.test.ts — exercises the edge surfaces no other
// gate suite reaches: author routes, the outbox enqueue, ops logging on both
// rejection paths, the salted-IP privacy path, feed surfaces and cursor
// round-trips, and the unregistered-path router fallthrough.
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { enqueueJob } from "../../src/enqueue.js";
import { db, SLUG, signedBotAuthHeaders } from "./helpers.js";

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
            post_id: "44444444-4444-4444-8444-000000000004",
            content_hash: "e31155826556dd6b2c73920c6a57a597e85e837fcd1166c9733a270ac5592aca",
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
      content_hash: "e31155826556dd6b2c73920c6a57a597e85e837fcd1166c9733a270ac5592aca",
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
