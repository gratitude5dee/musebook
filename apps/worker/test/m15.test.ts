// apps/worker/test/m15.test.ts — the M15 machinery against the live dev DB:
// registry-driven ranker resolution + flip reversibility (M15.2/3/4), the
// §13.4.1 label builder (M15.7), and the canonical shadow-point layout
// through feedPorts + writePoint (§9.18/§13.3.1).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { pgFreshJobs } from "../src/db.js";
import { resolveMuseRankers } from "../src/lib/rankers.js";
import { deriveNotDwelledLabels } from "../src/cron/label-builder.js";
import { feedPorts } from "../src/feed/ports.js";
import { buildSlateCore } from "../src/slate-builder.js";
import { HEURISTIC_V1_COEFFICIENTS } from "@musebook/muse-mixer";
import { LearnedMuseRanker } from "@musebook/muse-mixer";
import { withDb, SEED_POST_ID } from "./helpers/db.js";

const LEARNED = "v1.model-learned";
const HEURISTIC = "v1.model-heuristic";

async function seedLearnedRow(): Promise<void> {
  await withDb(async (c) => {
    // Coefficients as a ranking_weights blob under the model's own version —
    // data, not a runtime (§9.15 v1.1). `learned` is the blob key, `heuristic`
    // the fallback the resolver also accepts.
    await c.query(
      `insert into public.ranking_weights (weights_version, cohort, weights)
       values ($1, 'model:learned', $2::jsonb)
       on conflict (weights_version) do nothing`,
      [LEARNED, { learned: HEURISTIC_V1_COEFFICIENTS } as unknown as string],
    );
    await c.query(
      `insert into public.model_registry (model_version, family, status)
       values ($1, 'linear', 'shadow') on conflict (model_version) do nothing`,
      [LEARNED],
    );
  });
}

async function dropLearnedRow(): Promise<void> {
  await withDb(async (c) => {
    await c.query(`delete from public.model_registry where model_version = $1`, [LEARNED]);
    await c.query(`delete from public.ranking_weights where weights_version = $1`, [LEARNED]);
    await c.query(
      `update public.model_registry set status = 'active' where model_version = $1`,
      [HEURISTIC],
    );
  });
}

async function setStatus(version: string, status: string): Promise<void> {
  await withDb((c) =>
    c.query(`update public.model_registry set status = $2 where model_version = $1`, [
      version,
      status,
    ]),
  );
}

beforeEach(dropLearnedRow);

describe("resolveMuseRankers — model_registry is the mechanism (M15.2/3/4)", () => {
  it("resolves the seeded active heuristic, no shadow", async () => {
    const db = await pgFreshJobs(env);
    try {
      const r = await resolveMuseRankers(db);
      expect(r.activeVersion).toBe(HEURISTIC);
      expect(r.shadow).toBeNull();
    } finally {
      await db.end();
    }
  });

  it("a shadow row resolves to a LearnedMuseRanker under its own version", async () => {
    await seedLearnedRow();
    const db = await pgFreshJobs(env);
    try {
      const r = await resolveMuseRankers(db);
      expect(r.activeVersion).toBe(HEURISTIC);
      expect(r.shadow).toBeInstanceOf(LearnedMuseRanker);
      expect(r.shadow?.modelVersion).toBe(LEARNED);
    } finally {
      await db.end();
    }
  });

  it("flips and flips back — status UPDATEs only, resolver sees each state (M15.3)", async () => {
    await seedLearnedRow();
    const db = await pgFreshJobs(env);
    try {
      // flip: incumbent retires, candidate activates — registry rows only.
      await setStatus(HEURISTIC, "retired");
      await setStatus(LEARNED, "active");
      const promoted = await resolveMuseRankers(db);
      expect(promoted.activeVersion).toBe(LEARNED);
      expect(promoted.active).toBeInstanceOf(LearnedMuseRanker);

      // flip back: the rollback is the same shape — a status change, not a deploy.
      await setStatus(LEARNED, "retired");
      await setStatus(HEURISTIC, "active");
      const rolledBack = await resolveMuseRankers(db);
      expect(rolledBack.activeVersion).toBe(HEURISTIC);
    } finally {
      await db.end();
    }
  });

  it("a registry row without a coefficient blob is not promotable — falls back", async () => {
    await withDb(async (c) => {
      await c.query(
        `insert into public.model_registry (model_version, family, status)
         values ('v1.model-empty', 'linear', 'shadow') on conflict do nothing`,
      );
    });
    const db = await pgFreshJobs(env);
    try {
      const r = await resolveMuseRankers(db);
      expect(r.shadow).toBeNull();
    } finally {
      await db.end();
      await withDb((c) =>
        c.query(`delete from public.model_registry where model_version = 'v1.model-empty'`),
      );
    }
  });
});

describe("label builder — exactly one not_dwelled per settled impression (M15.7)", () => {
  const SESSION_A = crypto.randomUUID();
  const SESSION_B = crypto.randomUUID();
  const SLATE = crypto.randomUUID();

  beforeEach(async () => {
    await withDb(async (c) => {
      await c.query(
        `delete from public.action_events
          where view_session_id in ($1::uuid, $2::uuid) or slate_id = $3::uuid`,
        [SESSION_A, SESSION_B, SLATE],
      );
    });
  });

  async function insertEvent(
    action: string,
    sessionId: string,
    occurred: string,
    slateId = SLATE,
  ): Promise<void> {
    await withDb((c) =>
      c.query(
        `insert into public.action_events
           (occurred_at, actor_plane, viewer_user_id, anon_id, post_id, action, surface,
            slate_id, position, weights_version, model_version, view_session_id)
         values ($1::timestamptz, 'human', null, $7, $2, $3::action_kind, 'reels',
                 $4::uuid, 0, 'v1', $5, $6::uuid)`,
        [
          occurred,
          SEED_POST_ID,
          action,
          slateId,
          "v1.model-heuristic",
          sessionId,
          `anon-${sessionId}`,
        ],
      ),
    );
  }

  it("derives one row for impression-without-dwell; a rerun is a no-op", async () => {
    const old = new Date(Date.now() - 45 * 60_000).toISOString();
    await insertEvent("impression", SESSION_A, old);

    const first = await deriveNotDwelledLabels(env);
    expect(first).toBeGreaterThanOrEqual(1);

    const { rows } = await withDb((c) =>
      c.query<{ n: string; slate_id: string; model_version: string; weights_version: string }>(
        `select count(*)::text n, max(slate_id::text) slate_id,
                max(model_version) model_version, max(weights_version) weights_version
           from public.action_events
          where action = 'not_dwelled' and view_session_id = $1`,
        [SESSION_A],
      ),
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(rows[0]?.slate_id).toBe(SLATE);
    expect(rows[0]?.model_version).toBe("v1.model-heuristic");
    expect(rows[0]?.weights_version).toBe("v1");

    const second = await deriveNotDwelledLabels(env);
    const after = await withDb((c) =>
      c.query<{ n: string }>(
        `select count(*)::text n from public.action_events
          where action = 'not_dwelled' and view_session_id = $1`,
        [SESSION_A],
      ),
    );
    expect(Number(after.rows[0]?.n)).toBe(1);
    expect(second).toBeLessThanOrEqual(first);
  });

  it("labels nothing when a dwell row shares the session", async () => {
    const old = new Date(Date.now() - 45 * 60_000).toISOString();
    await insertEvent("impression", SESSION_B, old);
    await insertEvent("dwell", SESSION_B, old);
    await deriveNotDwelledLabels(env);
    const { rows } = await withDb((c) =>
      c.query<{ n: string }>(
        `select count(*)::text n from public.action_events
          where action = 'not_dwelled' and view_session_id = $1`,
        [SESSION_B],
      ),
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe("reels slate ≠ feed slate for the same viewer (M15.6)", () => {
  it("two builds for one viewer produce slates that are not permutations", async () => {
    // §9.23's seeded-viewer invariant: a follower with the largest still-unseen
    // in-network pool. A cold viewer selects nothing — in-network sources are
    // the ones the surfaces read differently. Clear the seen-bloom for
    // fresh-visit semantics (the reels build would otherwise starve home).
    const viewer = await withDb(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select f.follower_user_id as id
           from public.follows f
           join public.posts p
             on p.author_user_id = f.followee_user_id and p.status = 'published'
           left join public.viewer_seen_bloom v
             on v.viewer_user_id = f.follower_user_id
          where f.target_kind = 'user'
            and not (p.id = any(coalesce(v.recent_ids, '{}'::uuid[])))
          group by f.follower_user_id
          order by count(*) desc, f.follower_user_id
          limit 1`,
      );
      if (rows.length === 0) throw new Error("no viewer with unseen in-network posts");
      return rows[0]!.id;
    });
    await withDb(async (c) => {
      await c.query(`delete from public.viewer_seen_bloom where viewer_user_id = $1`, [viewer]);
      // needsBuild dedupes on a slate fresher than TTL/3 — clear this viewer's
      // prior builds or a same-minute rerun short-circuits with fresh_enough.
      await c.query(
        `delete from public.slate_items where slate_id in
           (select id from public.slates where viewer_user_id = $1)`,
        [viewer],
      );
      await c.query(`delete from public.slates where viewer_user_id = $1`, [viewer]);
    });
    // Reels first — its universe is kind-restricted, so a home build could
    // consume those ids into the shared bloom and starve it.
    const reels = await buildSlateCore(env, { surface: "reels", actorUserId: viewer });
    const feed = await buildSlateCore(env, { surface: "home", actorUserId: viewer });
    expect(reels.built, reels.reason ?? "").toBe(true);
    expect(feed.built, feed.reason ?? "").toBe(true);

    const items = (slateId: string | null) =>
      withDb((c) =>
        c.query<{ post_id: string; source: string; kind: string }>(
          `select i.post_id, i.source, p.kind from public.slate_items i
             join public.posts p on p.id = i.post_id
            where i.slate_id = $1 order by i.post_id, i.source`,
          [slateId],
        ),
      ).then((r) => r.rows);
    const reelsItems = await items(reels.slateId);
    const feedItems = await items(feed.slateId);
    expect(reelsItems.length).toBeGreaterThan(0);
    expect(feedItems.length).toBeGreaterThan(0);
    // Sorted-by-post_id multisets: equality here is a permutation, which is
    // the failure M15.6 names — the surfaces must differ beyond ordering.
    expect(reelsItems.map((i) => i.post_id)).not.toEqual(
      feedItems.map((i) => i.post_id),
    );
    // …and the reels universe is the kind-restricted one (video/audio only —
    // the pipeline's own source restriction, not a parameterisation of the
    // home scorer's): every reels item is a media kind while the feed slate
    // carries kinds reels can never serve.
    const reelsKinds = new Set(reelsItems.map((i) => i.kind));
    const feedKinds = new Set(feedItems.map((i) => i.kind));
    expect([...reelsKinds].every((k) => k === "video" || k === "audio")).toBe(true);
    expect([...feedKinds].some((k) => k !== "video" && k !== "audio")).toBe(true);
  });
});

describe("writeShadowPoint → canonical §13.3.1 layout through feedPorts", () => {
  it("lands index1/blob/double slots for a real feedPorts telemetry port", async () => {
    const written: Array<{ indexes?: string[]; doubles?: number[]; blobs?: string[] }> = [];
    const ae = { writeDataPoint: (p: (typeof written)[number]) => written.push(p) };
    const db = await pgFreshJobs(env);
    try {
      const ports = feedPorts({ cached: db, fresh: db, ae, telemetrySampleRate: 0.5 });
      ports.telemetry.writeShadowPoint({
        postId: "post-9",
        slateId: "slate-7",
        surface: "reels",
        weightsVersion: "v1.model-learned",
        modelVersion: "v1.model-learned",
        plane: "agent",
        position: 3,
        value: 0.42,
      });
    } finally {
      await db.end();
    }

    expect(written).toHaveLength(1);
    const p = written[0]!;
    expect(p.indexes?.[0]).toBe("post-9"); // index1 = post
    expect(p.blobs?.[0]).toBe("muse.shadow_score"); // blob1 = metric
    expect(p.blobs?.[1]).toBe("agent"); // blob2 = plane
    expect(p.blobs?.[2]).toBe("reels"); // blob3 = surface
    expect(p.blobs?.[3]).toBe("slate-7"); // blob4 = slate
    expect(p.blobs?.[4]).toBe("v1.model-learned"); // blob5 = weights_version
    expect(p.blobs?.[5]).toBe("v1.model-learned"); // blob6 = model_version
    expect(p.doubles?.[0]).toBe(3); // double1 = position
    expect(p.doubles?.[2]).toBe(0.5); // double3 = sample_rate
    expect(p.doubles?.[7]).toBe(0.42); // double8 = value
  });
});
