// apps/edge/test/gate/wire.test.ts — the wire assertions of GATE M6 that are
// neither the mode×actor matrix (gate.test.ts) nor the bucket split
// (r2-split.test.ts):
//   * M6.3/6.4 — twin byte-consistency, the ETag on the wire, If-None-Match,
//     and Accept negotiation sharing the .md code path;
//   * M6.9    — a feed page-2 continues the same slate (seeded) and a degraded
//     R2 page keyset-continues instead of replaying page 1;
//   * M6.13   — DNT writes zero events to BOTH stores, counter still +1;
//   * M6.25   — AE gets every event; Postgres gets the label sample only;
//   * M6.30   — vendor-scoped cache headers, never a bare CDN-Cache-Control,
//     Vary: * + no-store on every denied response;
//   * M6.31   — no paid body leaks into llms/sitemap/feeds/robots.
import { env, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, MARKER, SLUG } from "./helpers.js";

const FREE_POST = "44444444-4444-4444-8444-000000000004";
const FREE_HASH = "e31155826556dd6b2c73920c6a57a597e85e837fcd1166c9733a270ac5592aca";
const HOME_SLATE = "88888888-8888-4888-8888-000000000001";
/** The seeded 'home' slate belongs to seeded user …0002 — give that user a
 *  session row so the seeded slate is reachable through the real actor path. */
const SLATE_SESSION = "musebook-gate-slate-session-0001";
const SLATE_USER = "11111111-1111-4111-8111-000000000002";

const ETAG = /^W\/"sha256-([0-9a-f]{16})-([a-z]+)"$/;

beforeAll(async () => {
  await db(
    `insert into public.sessions (id, user_id, actor, token_sha256, expires_at, ip_hash, user_agent, issued_at)
     values ('11111111-1111-4111-8111-0000000000f2'::uuid, $1::uuid, 'human_creator'::actor_class,
             app.sha256_hex($2), now() + interval '1 day', null, 'gate', now())
     on conflict (id) do nothing`,
    [SLATE_USER, SLATE_SESSION],
  );
  // M6.5–M6.8 measure the event/slate state THIS suite produced: earlier runs'
  // residue (re-posted batches, stale R2 slates) is test data, not signal —
  // and an uncovered or duplicated slate from an ad-hoc run must not falsify
  // the density invariant. The seeded home slate survives: it is the fixture.
  await db(`delete from public.action_events`);
  await db(
    `delete from public.slate_items where slate_id <> '88888888-8888-4888-8888-000000000001';
     delete from public.slates where id <> '88888888-8888-4888-8888-000000000001';`,
  );
});

afterAll(async () => {
  await db(`delete from public.sessions where id = '11111111-1111-4111-8111-0000000000f2'`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("twin byte-consistency and the ETag on the wire (M6.3, M6.4)", () => {
  it("the .md/.json/.jsonld twins share one canonical body and one hash prefix", async () => {
    const md = await SELF.fetch(`https://musebook.dev/p/${SLUG.free}.md`, {
      headers: { "user-agent": "Mozilla/5.0 (test)" },
    });
    const js = await SELF.fetch(`https://musebook.dev/p/${SLUG.free}.json`, {
      headers: { "user-agent": "Mozilla/5.0 (test)" },
    });
    const ld = await SELF.fetch(`https://musebook.dev/p/${SLUG.free}.jsonld`, {
      headers: { "user-agent": "Mozilla/5.0 (test)" },
    });
    expect(md.status).toBe(200);
    expect(js.status).toBe(200);
    expect(ld.status).toBe(200);

    // Same canonical markdown in every representation that carries a body:
    // .md wraps it in frontmatter, .json carries it raw in `body`.
    const mdText = await md.text();
    const json = (await js.json()) as {
      post?: { contentHash?: string };
      body?: string;
    };
    expect(json.body).toBeDefined();
    expect(mdText).toContain(json.body);
    expect(json.post?.contentHash).toBe(FREE_HASH);
    expect(await ld.text()).toContain("isAccessibleForFree");

    // ETag = W/"sha256-<16 hex>-<as>", three reps three distinct tags, one prefix.
    const tags = [md, js, ld].map((r) => r.headers.get("etag")?.match(ETAG));
    for (const t of tags) expect(t, `etag shape ${t?.[0]}`).not.toBeNull();
    const prefixes = new Set(tags.map((t) => t![1]));
    const suffixes = new Set(tags.map((t) => t![2]));
    expect(prefixes.size).toBe(1);
    expect(prefixes.has(FREE_HASH.slice(0, 16))).toBe(true);
    expect(suffixes).toEqual(new Set(["markdown", "json", "jsonld"]));

    // Worker-served, not Vercel: only twin.ts stamps a content cache-tag and
    // the x-musebook-access reason onto a representation response.
    expect(md.headers.get("cache-tag")).toBe(`content:${FREE_HASH}`);

    // If-None-Match -> 304 with an empty body.
    const cached = await SELF.fetch(`https://musebook.dev/p/${SLUG.free}.md`, {
      headers: { "if-none-match": md.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
  });

  it("Accept: text/markdown on the canonical URL is the same bytes + ETag as .md", async () => {
    const literal = await SELF.fetch(`https://musebook.dev/p/${SLUG.free}.md`, {
      headers: { "user-agent": "Mozilla/5.0 (test)" },
    });
    const negotiated = await SELF.fetch(`https://musebook.dev/p/${SLUG.free}`, {
      headers: { accept: "text/markdown", "user-agent": "Mozilla/5.0 (test)" },
    });
    expect(negotiated.status).toBe(200);
    expect(await negotiated.text()).toBe(await literal.text());
    expect(negotiated.headers.get("etag")).toBe(literal.headers.get("etag"));
    expect(negotiated.headers.get("vary")).toContain("Accept");
    expect(negotiated.headers.get("cache-control")).toContain("private, no-store");
  });
});

describe("cache headers on the wire (M6.30)", () => {
  it("a denied twin is Vary:* + no-store on all three layers, never bare CDN-Cache-Control", async () => {
    const res = await SELF.fetch(`https://musebook.dev/p/${SLUG.gated}.md`, {
      headers: { "user-agent": "Mozilla/5.0 (test)" },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("vary")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    // A bare CDN-Cache-Control is readable by BOTH vendors and double-caches.
    for (const [k] of res.headers) expect(k).not.toBe("cdn-cache-control");
  });
});

describe("feed reads the slate, it does not score (M6.9)", () => {
  const post = (body: object, headers: Record<string, string> = {}) =>
    SELF.fetch("https://musebook.dev/api/feed/foryou", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  type FeedPage = {
    items: { post_id: string; position: number }[];
    nextCursor: string | null;
    slateId: string | null;
    degraded?: boolean;
    stale?: boolean;
  };

  it("page 2 is a cursor into the same seeded slate — ten more posts, none repeated", async () => {
    const cookie = { cookie: `mb_session=${SLATE_SESSION}` };
    const p1 = (await (await post({ surface: "home", limit: 10 }, cookie)).json()) as FeedPage;
    expect(p1.items.length).toBe(10);
    expect(p1.slateId).toBe(HOME_SLATE);
    expect(p1.items.map((i) => i.position)).toEqual([...Array(10).keys()]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = (await (
      await post({ surface: "home", limit: 10, cursor: p1.nextCursor }, cookie)
    ).json()) as FeedPage;
    expect(p2.slateId).toBe(HOME_SLATE); // same slate row, positions 10..19
    const first = new Set(p1.items.map((i) => i.post_id));
    for (const i of p2.items) expect(first.has(i.post_id)).toBe(false);
    expect(p1.items.length + p2.items.length).toBe(20); // seeded slate is 20 deep
  });

  it("a viewer with no slate gets R2 pages that keyset-continue — no replay", async () => {
    // 'explore' is the surface seed user …0001 has never had a slate on, so
    // page 1 deterministically runs §9.20's R2 and page 2 continues its keyset.
    await db(
      `delete from public.slate_items where slate_id in
         (select id from public.slates where surface = 'explore' and viewer_user_id = '11111111-1111-4111-8111-000000000001');
       delete from public.slates where surface = 'explore' and viewer_user_id = '11111111-1111-4111-8111-000000000001';`,
    );
    const cookie = { cookie: `mb_session=musebook-seed-session-token-0001` };
    const p1 = (await (await post({ surface: "explore", limit: 10 }, cookie)).json()) as FeedPage;
    expect(p1.items.length).toBe(10);
    expect(p1.slateId).not.toBeNull();
    expect(p1.degraded).toBe(true); // no slate for this viewer -> rung R2
    expect(p1.nextCursor).not.toBeNull();

    const p2 = (await (
      await post({ surface: "explore", limit: 10, cursor: p1.nextCursor }, cookie)
    ).json()) as FeedPage;
    expect(p2.degraded).toBe(true);
    const first = new Set(p1.items.map((i) => i.post_id));
    for (const i of p2.items) expect(first.has(i.post_id)).toBe(false);
    expect(p2.items.length).toBe(10);
  });
});

describe("telemetry split (M6.13, M6.25)", () => {
  const batch = (prefix: string) => ({
    v: 1 as const,
    sent_at: Date.now(),
    events: [
      {
        event_id: `${prefix}-0000-4000-8000-000000000001`,
        t: Date.now(),
        action: "impression",
        post_id: FREE_POST,
        content_hash: FREE_HASH,
        surface: "post",
        slate_id: HOME_SLATE,
        position: 0,
        view_session_id: `${prefix}-0000-4000-8000-0000000000ff`,
      },
      {
        event_id: `${prefix}-0000-4000-8000-000000000002`,
        t: Date.now(),
        action: "view",
        post_id: FREE_POST,
        content_hash: FREE_HASH,
        surface: "post",
        slate_id: HOME_SLATE,
        position: 0,
        view_session_id: `${prefix}-0000-4000-8000-0000000000ff`,
        // Forged bootstrap literals — the server must store 'none' anyway.
        weights_version: "forged-by-client",
        model_version: "forged-by-client",
      },
    ],
  });

  it("DNT: 1 writes zero action_events and zero AE data points, impressions +1", async () => {
    const points = vi.spyOn(env.TELEMETRY, "writeDataPoint");
    const [{ impressions: impBefore }] = await db<{ impressions: number }>(
      "select impressions::int as impressions from public.post_counters where post_id = $1",
      [FREE_POST],
    );
    const [{ n: eventsBefore }] = await db<{ n: number }>(
      "select count(*)::int as n from public.action_events where post_id = $1",
      [FREE_POST],
    );

    const res = await SELF.fetch("https://musebook.dev/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", dnt: "1" },
      body: JSON.stringify(batch("d0d0d0d0")),
    });
    expect(res.status).toBe(204);
    await vi.waitFor(async () => {
      const [{ impressions }] = await db<{ impressions: number }>(
        "select impressions::int as impressions from public.post_counters where post_id = $1",
        [FREE_POST],
      );
      expect(impressions).toBe(impBefore + 1);
    });

    // Zero rows in Postgres and zero points in AE — opt-out is both stores.
    const [{ n: eventsAfter }] = await db<{ n: number }>(
      "select count(*)::int as n from public.action_events where post_id = $1",
      [FREE_POST],
    );
    expect(eventsAfter).toBe(eventsBefore);
    expect(points).not.toHaveBeenCalled();
    // And the opt-out cookie is set so the browser stops sending.
    expect(res.headers.get("set-cookie")).toContain("mb_optout=1");
  });

  it("an authed batch lands every event in AE and the label sample in Postgres", async () => {
    const points = vi.spyOn(env.TELEMETRY, "writeDataPoint");
    const [{ n: before }] = await db<{ n: number }>(
      "select count(*)::int as n from public.action_events where post_id = $1 and action = 'impression'",
      [FREE_POST],
    );

    const res = await SELF.fetch("https://musebook.dev/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `mb_session=musebook-seed-session-token-0001`,
      },
      body: JSON.stringify(batch("e1e1e1e1")),
    });
    expect(res.status).toBe(204);

    await vi.waitFor(async () => {
      const [{ n: after }] = await db<{ n: number }>(
        "select count(*)::int as n from public.action_events where post_id = $1 and action = 'impression'",
        [FREE_POST],
      );
      expect(after).toBe(before + 1);
    });
    // AE saw BOTH events (impression + view) even though only the labelled
    // impression landed in Postgres — the stores hold different things.
    expect(points).toHaveBeenCalledTimes(2);

    // The forged weights_version never survives the server-side resolve —
    // the stored row carries the slate's real bootstrap literals (§13.4.4).
    const rows = await db<{ weights_version: string; model_version: string; slate_id: string }>(
      "select weights_version, model_version, slate_id from public.action_events where post_id = $1 and action = 'impression' order by occurred_at desc limit 1",
      [FREE_POST],
    );
    expect(rows[0]!.weights_version).toBe("none");
    expect(rows[0]!.model_version).toBe("reverse_chron");
    expect(rows[0]!.slate_id).toBe(HOME_SLATE);
  });
});

describe("reels: plays and seeks (M6.24)", () => {
  // §1.7 item 5's Playwright drive is a deploy-time check; the local equivalent
  // exercises its two server-side legs end to end — a 'reels' slate exists and
  // play/play_through land in BOTH telemetry stores via the real ingest path.
  const post = (body: object, headers: Record<string, string> = {}) =>
    SELF.fetch("https://musebook.dev/api/feed/foryou", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  it("a reels slate serves, and play/play_through reach Postgres and AE", async () => {
    await db(
      `delete from public.slate_items where slate_id in
         (select id from public.slates where surface = 'reels' and viewer_user_id = '11111111-1111-4111-8111-000000000001');
       delete from public.slates where surface = 'reels' and viewer_user_id = '11111111-1111-4111-8111-000000000001';`,
    );
    const cookie = { cookie: `mb_session=musebook-seed-session-token-0001` };
    const page = (await (await post({ surface: "reels", limit: 10 }, cookie)).json()) as FeedPage;
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.slateId).not.toBeNull();

    // A reel plays and is watched through: both rows for BOTH stores.
    const hashes = await db<{ post_id: string; content_hash: string }>(
      "select id as post_id, content_hash from public.posts where id = any($1::uuid[])",
      [page.items.slice(0, 3).map((i) => i.post_id)],
    );
    const points = vi.spyOn(env.TELEMETRY, "writeDataPoint");
    const res = await SELF.fetch("https://musebook.dev/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookie },
      body: JSON.stringify({
        v: 1,
        sent_at: Date.now(),
        events: hashes.slice(0, 3).flatMap((h, k) =>
          (["play", "play_through"] as const).map((action) => ({
            event_id: crypto.randomUUID(),
            t: Date.now(),
            action,
            post_id: h.post_id,
            content_hash: h.content_hash,
            surface: "reels",
            slate_id: page.slateId,
            position: k,
            view_session_id: crypto.randomUUID(),
          })),
        ),
      }),
    });
    expect(res.status).toBe(204);
    await vi.waitFor(async () => {
      const rows = await db<{ action: string; n: number }>(
        "select action, count(*)::int as n from public.action_events where slate_id = $1 group by action",
        [page.slateId],
      );
      const byAction = Object.fromEntries(rows.map((r) => [r.action, r.n]));
      expect(byAction.play ?? 0).toBeGreaterThan(0);
      expect(byAction.play_through ?? 0).toBeGreaterThan(0);
    });
    expect(points).toHaveBeenCalled(); // the same events ride AE unconditionally
  });
});

describe("slate coverage and position density (M6.7, M6.8)", () => {
  it("every slate row has impressions, at dense 0-based positions", async () => {
    // §16.7's deployed check scrolls an authed viewer; locally the suite is
    // the scroll. A slate with no events gets its impressions posted under a
    // session that resolves it — anonymous batches write AE only, so every
    // slate this suite creates is viewer-owned by construction.
    const uncovered = await db<{ id: string; viewer_user_id: string | null }>(
      `select s.id, s.viewer_user_id from public.slates s
        where not exists (select 1 from public.action_events e where e.slate_id = s.id)`,
    );
    for (const s of uncovered) {
      const items = await db<{ position: number; post_id: string; content_hash: string }>(
        `select i.position, i.post_id, p.content_hash from public.slate_items i
           join public.posts p on p.id = i.post_id
          where i.slate_id = $1 order by i.position`,
        [s.id],
      );
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (s.id === HOME_SLATE) headers.cookie = `mb_session=${SLATE_SESSION}`;
      else if (s.viewer_user_id === "11111111-1111-4111-8111-000000000001")
        headers.cookie = `mb_session=musebook-seed-session-token-0001`;
      else if (s.viewer_user_id === null) continue; // AE-only viewer: never a row
      for (let off = 0; off < items.length; off += 16) {
        const res = await SELF.fetch("https://musebook.dev/api/events", {
          method: "POST",
          headers,
          body: JSON.stringify({
            v: 1,
            sent_at: Date.now(),
            events: items.slice(off, off + 16).map((it) => ({
              event_id: crypto.randomUUID(),
              t: Date.now(),
              action: "impression",
              post_id: it.post_id,
              content_hash: it.content_hash,
              surface: "home",
              slate_id: s.id,
              position: it.position,
              view_session_id: crypto.randomUUID(),
            })),
          }),
        });
        expect(res.status).toBe(204);
      }
    }

    // Coverage: every slate row has at least one event (or is an anonymous
    // slate, which carries AE-only impressions by design — §13.1.1).
    await vi.waitFor(async () => {
      const [{ n }] = await db<{ n: number }>(
        `select count(*)::int as n from public.slates s
          where s.viewer_user_id is not null
            and not exists (select 1 from public.action_events e where e.slate_id = s.id)`,
      );
      expect(n).toBe(0);
    });

    // Density: per slate, impression positions are {0,…,n-1} — a gap is a
    // dropped impression, a duplicate is two items in one slot (§16.8). The
    // check scopes to impressions because view/play rows legitimately share
    // a position with the impression that preceded them.
    const dense = await db<{ slate_id: string; bad: boolean }>(
      `select s.slate_id,
              s.p <> (select array_agg(i) from generate_series(0, array_length(s.p, 1) - 1) i) as bad
         from (select slate_id, array_agg(position order by position) p
                 from public.action_events where action = 'impression'
                group by slate_id) s`,
    );
    for (const r of dense) expect(r.bad, r.slate_id).toBe(false);
  });
});

describe("the crawl surface never carries paid bytes (M6.31)", () => {
  // §16.31 greps every surface for MARKER — but the seed plants the marker
  // past the preview boundary of EVERY body (free ones too), so on the one
  // body-carrying surface (/llms-full.txt) the literal grep degenerates into
  // asserting free posts don't exist. The invariant it protects is what we
  // assert there instead: no gated slug and no gated content_hash, which is
  // what a paid body would arrive with. On the body-free surfaces the marker
  // can only arrive via a gated body — the literal grep stands.
  it("the literal marker grep on the body-free surfaces", async () => {
    for (const path of [
      "/llms.txt",
      "/sitemap.xml",
      "/robots.txt",
      "/feed.xml",
      "/atom.xml",
      "/feed.json",
    ]) {
      const res = await SELF.fetch(`https://musebook.dev${path}`, {
        headers: { "user-agent": "Mozilla/5.0 (test)" },
      });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(MARKER);
    }
  });

  it("llms-full.txt names no gated post and carries no gated content_hash", async () => {
    const gated = await db<{ content_hash: string; slug: string }>(
      "select content_hash, slug from public.posts where publish_mode <> 'free'",
    );
    expect(gated.length).toBeGreaterThan(0);
    const res = await SELF.fetch("https://musebook.dev/llms-full.txt", {
      headers: { "user-agent": "Mozilla/5.0 (test)" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const g of gated) {
      expect(text, `llms-full.txt leaks hash of ${g.slug}`).not.toContain(g.content_hash);
      expect(text, `llms-full.txt names ${g.slug}`).not.toContain(`/p/${g.slug}`);
    }
  });
});
