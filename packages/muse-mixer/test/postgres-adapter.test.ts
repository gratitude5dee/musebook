// packages/muse-mixer/test/postgres-adapter.test.ts — exercises the pg
// adapter against the live local Supabase. Every source SQL must execute
// against the real schema (a verbatim spec is schema-forward-invalid if a
// column lands later — §11.13's remix_root_id — so this file is the
// proof every query parses and returns rows today).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresDbHandles, PostgresWeightsLoader, SOURCE_SQL } from "../src/adapters/pg.js";

const DB_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

function sqlClient(c: pg.Client) {
  return {
    query: async <T = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
      const res = await c.query(text, params as unknown[] | undefined);
      return { rows: res.rows as T[] };
    },
  };
}

let client: pg.Client;
let viewerId: string;
let authorId: string;
let follows: string[];
let topics: string[];

beforeAll(async () => {
  client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const author = await client.query<{ author_user_id: string }>(
    `select author_user_id from public.posts where status = 'published' limit 1`,
  );
  authorId = author.rows[0].author_user_id;
  const viewer = await client.query<{ id: string }>(
    `select u.id from public.users u
      where u.id <> $1
        and not exists (select 1 from public.slates s where s.viewer_user_id = u.id)
      limit 1`,
    [authorId],
  );
  viewerId = viewer.rows[0].id;
  follows = (
    await client.query<{ followee_user_id: string }>(
      `select followee_user_id from public.follows
        where target_kind = 'user' and follower_user_id = $1 limit 3`,
      [viewerId],
    )
  ).rows.map((r) => r.followee_user_id);
  topics = (
    await client.query<{ slug: string }>(
      `select distinct unnest(topics) as slug from public.post_classifications limit 3`,
    )
  ).rows.map((r) => r.slug);
  if (topics.length === 0) topics = ["seed-music"];
});

afterAll(async () => {
  await client.end();
});

describe("pg adapter source queries", () => {
  it("runs all 11 source queries against the live schema", async () => {
    const db = sqlClient(client);
    const cases: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      ["follow_graph", [follows, viewerId, null, 400]],
      ["topic", [topics, null, 400]],
      ["trending", [168, null, 400]],
      ["by_authors_recent", [follows, null, 400]],
      ["agent_authored", [null, 400]],
      ["app_artifact", [viewerId, 400]],
      ["remix_lineage", [[crypto.randomUUID()], null, 400]],
      ["cold_start_seed", [50, null, 400]],
      ["completion_trending", [["video", "audio"], 500]],
      ["soundtrack", [viewerId, 400]],
      ["reverse_chron", [viewerId, null, 200]],
    ];
    for (const [name, params] of cases) {
      const { rows } = await db.query(SOURCE_SQL[name] as string, params);
      expect(Array.isArray(rows), name).toBe(true);
    }
  });

  it("source rows carry the §9.5 candidate columns", async () => {
    const db = sqlClient(client);
    const { rows } = await db.query<Record<string, unknown>>(
      SOURCE_SQL["reverse_chron"] as string,
      [viewerId, null, 5],
    );
    for (const row of rows) {
      expect(row).toHaveProperty("post_id");
      expect(row).toHaveProperty("content_hash");
      expect(row).toHaveProperty("author_user_id");
      expect(row).toHaveProperty("published_at_ms");
      expect(row).toHaveProperty("remix_root_id");
      expect(row["remix_root_id"]).toBeNull(); // §11.13 lands it at M16
    }
  });
});

describe("pg adapter ports", () => {
  it("graph/recent/posts/retrieval/slates/bloom/clusters respond", async () => {
    const db = sqlClient(client);
    const handles = postgresDbHandles({
      cached: db,
      fresh: db,
      monetization: {
        async loadMonetization() {
          return new Map();
        },
      },
      telemetry: {
        writeDataPoint: () => undefined,
        insertAgentActions: () => Promise.resolve(),
      },
    });

    await expect(handles.graph.followedCreatorIds(viewerId)).resolves.toBeInstanceOf(Array);
    await expect(handles.graph.followerCreatorIds(authorId)).resolves.toBeInstanceOf(Array);
    await expect(handles.graph.followedTopicIds(viewerId)).resolves.toBeInstanceOf(Array);
    await expect(handles.graph.blockedUserIds(viewerId)).resolves.toBeInstanceOf(Array);
    const muted = await handles.graph.mutedBy(viewerId);
    expect(Array.isArray(muted.userIds)).toBe(true);
    expect(Array.isArray(muted.keywords)).toBe(true);
    await expect(handles.graph.paidContentHashes(viewerId, null)).resolves.toBeInstanceOf(Array);

    const seq = await handles.recent.loadViewerSequence(viewerId, null);
    if (seq !== null) {
      expect(seq.actionCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(seq.actions)).toBe(true);
    }

    const postIds = (
      await client.query<{ id: string }>(
        `select id from public.posts where status = 'published' limit 5`,
      )
    ).rows.map((r) => r.id);
    await expect(handles.posts.loadCore(postIds)).resolves.toBeInstanceOf(Map);
    await expect(handles.posts.loadMedia(postIds)).resolves.toBeInstanceOf(Map);
    await expect(handles.posts.loadPostStats(postIds)).resolves.toBeInstanceOf(Map);
    await expect(handles.posts.loadClassifications([])).resolves.toBeInstanceOf(Map);
    await expect(handles.posts.loadAgentIdentities([])).resolves.toBeInstanceOf(Map);
    await expect(handles.posts.loadArtifactState(postIds)).resolves.toBeInstanceOf(Map);
    await expect(
      handles.posts.trending({ hours: 168, kinds: null, limit: 5 }),
    ).resolves.toBeInstanceOf(Array);
    await expect(
      handles.posts.runSourceQuery("reverse_chron", [viewerId, null, 5]),
    ).resolves.toBeInstanceOf(Array);

    const emb = await handles.retrieval.viewerEmbedding(viewerId);
    if (emb !== null) expect(emb).toHaveLength(1536);
    await expect(handles.retrieval.postEmbeddings([])).resolves.toBeInstanceOf(Map);
    await expect(
      handles.retrieval.similarPosts([...new Array<number>(1536).fill(0.01)], {
        hours: 24 * 30,
        kinds: null,
        excludeAuthorIds: [],
        limit: 5,
      }),
    ).resolves.toBeInstanceOf(Array);
    const centroid = await handles.retrieval.newUserIndexEmbedding("cohort-centroid");
    if (centroid !== null) expect(centroid).toHaveLength(1536);

    await expect(handles.slates.needsBuild(viewerId, null, "home", 900)).resolves.toBeTypeOf(
      "boolean",
    );
    await expect(handles.slates.previousScores(viewerId, null, "home")).resolves.toBeNull();
    await expect(
      handles.slates.writeSlate({
        id: crypto.randomUUID(),
        viewerUserId: viewerId,
        viewerAgentId: null,
        surface: "home",
        weightsVersion: "v1",
        modelVersion: "v1.model-heuristic",
        params: { test: true },
        expiresAt: new Date(Date.now() + 900_000),
        items: postIds.slice(0, 3).map((postId, i) => ({
          position: i,
          postId,
          source: "test",
          actionScores: { like: 0.5 },
          weightedScore: 1.5,
          score: 100.5,
        })),
      }),
    ).resolves.toBeUndefined();

    const seen = await handles.bloom.loadSeen(viewerId);
    expect(seen === null || typeof seen.isoWeek === "string").toBe(true);
    await handles.bloom.updateSeen({
      viewerUserId: viewerId,
      isoWeek: "2099-W01",
      filterJson: "e30=",
      servedIds: postIds.slice(0, 2),
      maxRecentIds: 50,
    });

    await expect(handles.clusters.clustersForCreators([authorId])).resolves.toBeInstanceOf(Map);
    await expect(handles.clusters.creatorsForClusters([1], 10)).resolves.toBeInstanceOf(Array);
    await expect(handles.clusters.viewerClusters(viewerId, 10)).resolves.toBeInstanceOf(Array);
  });

  it("weights loader resolves the seeded v1 rows", async () => {
    const db = sqlClient(client);
    const loader = new PostgresWeightsLoader(db);
    const w = await loader.load({
      family: "v1",
      viewerKind: "human",
      isNewUserForRanking: false,
      countryCode: null,
      surface: "home",
      experimentBucket: "exp:b0",
    });
    expect(w.version).toMatch(/^v1/);
    for (const key of ["negativeSum", "totalSum"] as const) {
      expect(w[key]).toBeTypeOf("number");
      expect(w[key]).toBeGreaterThan(0);
    }
  });
});
