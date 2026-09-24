// apps/worker/scripts/m13-mixer-probe.mts — the M13 gate's live-build probe.
// Composes the production path (postgres adapter ports, jobs-scoped clients,
// PostgresWeightsLoader, muse/reels pipelines) against the local Supabase and
// prints one PASS/FAIL line per sub-check. Invoked by scripts/gates/checks.mjs.
//
//   tsx scripts/m13-mixer-probe.mts build
//   tsx scripts/m13-mixer-probe.mts degraded
//   tsx scripts/m13-mixer-probe.mts weights
//   tsx scripts/m13-mixer-probe.mts p95
import pg from "pg";
import {
  buildQuery,
  cohortKeyFor,
  execute,
  HeuristicMuseRanker,
  musePipeline,
  reelsPipeline,
  slateRowFor,
} from "@musebook/muse-mixer";
import { PostgresWeightsLoader } from "@musebook/muse-mixer/adapters/pg";
import { workersExecCtx } from "@musebook/muse-mixer/adapters/workers";
import type { StatsSink } from "@musebook/muse-mixer";
import { feedPorts } from "../src/feed/ports.js";

const WORKER_URL = "postgres://musebook_worker:postgres@127.0.0.1:54322/postgres";
const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const ENV = { MUSE_WEIGHTS_VERSION: "v1", MUSE_TOPK_CANDIDATES: "100" };

function sqlClient(c: pg.Client) {
  return {
    query: async <T = Record<string, unknown>,>(text: string, params?: readonly unknown[]) => {
      const res = await c.query(text, params as unknown[] | undefined);
      return { rows: res.rows as T[] };
    },
    end: () => c.end(),
  };
}

async function clients() {
  const cached = new pg.Client({ connectionString: WORKER_URL });
  const fresh = new pg.Client({ connectionString: WORKER_URL });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await Promise.all([cached.connect(), fresh.connect(), admin.connect()]);
  // production scoping — apps/worker db.ts pgCachedJobs/pgFreshJobs
  await cached.query("set role musebook_jobs");
  await fresh.query("set role musebook_jobs");
  return {
    cached: sqlClient(cached),
    fresh: sqlClient(fresh),
    admin,
    close: async () => Promise.allSettled([cached.end(), fresh.end(), admin.end()]),
  };
}

function capturedStats() {
  const entries: { name: string; value: number; tags?: Record<string, string> }[] = [];
  const sink: StatsSink = {
    counter(name, value, tags) {
      entries.push({ name, value, tags });
    },
    timing() {},
  };
  return { entries, sink };
}

async function build(surface: string, viewerId: string | null, stats?: StatsSink) {
  const { cached, fresh, close } = await clients();
  try {
    const ports = feedPorts({ cached, fresh, telemetrySampleRate: 1 });
    const base = workersExecCtx({ env: ENV, db: ports });
    const loader = new PostgresWeightsLoader(cached);
    const query = buildQuery({ surface, actorUserId: viewerId, actorAgentId: null }, base);
    let gates: Record<string, number | boolean> = {};
    try {
      gates = (await loader.load(cohortKeyFor(query, base))).gates;
    } catch {
      gates = {};
    }
    const ctx = workersExecCtx({
      env: ENV,
      db: ports,
      gates,
      ...(stats === undefined ? {} : { stats }),
    });
    const pipeline =
      surface === "reels"
        ? reelsPipeline({ ranker: new HeuristicMuseRanker(), weightsLoader: loader })
        : musePipeline({ ranker: new HeuristicMuseRanker(), weightsLoader: loader });
    const result = await execute(pipeline, query, ctx);
    if (process.env["M13_DEBUG"] === "1") {
      console.log(`DEBUG summary=${JSON.stringify(result.summary, null, 0).slice(0, 3000)}`);
    }
    await ports.slates.writeSlate(slateRowFor(query, result));
    await result.sideEffects();
    return { query, result };
  } finally {
    await close();
  }
}

async function pickViewer(admin: pg.Client): Promise<string> {
  // §9.23's "seeded viewer" needs unseen published posts in-network: home and
  // reels builds share the seen-bloom, so the second build starves on a shallow
  // pool. Pick the follower with the largest still-unseen published pool
  // (recent_ids is the exact ring the filter also consults).
  const { rows } = await admin.query<{ id: string }>(
    `select f.follower_user_id as id, count(*) as n
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
  return rows[0].id;
}

async function main() {
  const sub = process.argv[2];
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    if (sub === "build") {
      // §9.23: seeded viewer has home AND reels slates with candidate_count > 0.
      // Reels first: its candidate universe is kind-restricted (video/audio),
      // so a home build can consume those ids into the seen-bloom and starve it.
      const viewer = await pickViewer(admin);
      // Fresh-visit semantics: previous probe runs consumed this viewer's
      // in-network pool into the shared seen-bloom, which deterministically
      // starves a second run. Clear it first — the build's own bloom update
      // rewrites it (same setup the degraded check performs).
      await admin.query("delete from public.viewer_seen_bloom where viewer_user_id = $1", [viewer]);
      for (const surface of ["reels", "home"] as const) {
        await build(surface, viewer);
      }
      const { rows } = await admin.query<{ n: number }>(
        `select count(distinct surface)::int n from public.slates
          where viewer_user_id = $1 and surface in ('home','reels') and candidate_count > 0`,
        [viewer],
      );
      console.log(
        rows[0].n === 2
          ? `BUILD_OK viewer=${viewer} surfaces=${rows[0].n}`
          : `BUILD_FAIL surfaces=${rows[0].n}`,
      );
      return;
    }

    if (sub === "degraded") {
      // §9.23: user_embeddings truncated -> build still produces a full slate
      // and muse.stage.disabled{stage=sources,name=EmbeddingRetrievalSource}
      // increments — no error.
      const { entries, sink } = capturedStats();
      // Any in-network viewer works here — the assertion is embedding-loss
      // resilience, not unseen state — so pick the deepest graph and clear its
      // seen rows; the build's own bloom update rewrites them anyway.
      const { rows: vs } = await admin.query<{ id: string }>(
        `select f.follower_user_id as id
           from public.follows f
           join public.posts p on p.author_user_id = f.followee_user_id
                               and p.status = 'published'
          where f.target_kind = 'user'
          group by f.follower_user_id
          order by count(*) desc, f.follower_user_id
          limit 1`,
      );
      if (vs.length === 0) throw new Error("no in-network viewer");
      const viewer = vs[0].id;
      await admin.query("delete from public.viewer_seen_bloom where viewer_user_id = $1", [viewer]);
      await admin.query(
        "create table if not exists _m13_ue_bak as select * from public.user_embeddings",
      );
      try {
        await admin.query("delete from public.user_embeddings");
        const { result } = await build("home", viewer, sink);
        const disabled = entries.some(
          (e) =>
            e.name === "muse.stage.disabled" &&
            e.tags?.["stage"] === "sources" &&
            e.tags?.["name"] === "EmbeddingRetrievalSource",
        );
        console.log(
          result.selected.length > 0 && disabled
            ? `DEGRADED_OK selected=${result.selected.length}`
            : `DEGRADED_FAIL selected=${result.selected.length} disabledFlag=${disabled}`,
        );
      } finally {
        await admin.query(
          `insert into public.user_embeddings (user_id, model, embedding, n_events, updated_at)
             select b.user_id, 'seed-deterministic-v0',
                    (select array_agg((('x' || substr(app.sha256_hex(b.user_id::text), 1 + mod(g, 59), 6))::bit(24)::int % 10000)::real / 10000.0)
                       from generate_series(1, 1536) g)::extensions.vector(1536),
                    8, now()
               from _m13_ue_bak b
             on conflict (user_id) do nothing`,
        );
        await admin.query("drop table if exists _m13_ue_bak");
      }
      return;
    }

    if (sub === "weights") {
      // §16.7 three-score discipline: a ranking_weights row change changes the
      // loaded weights — and therefore the slate — with no deploy.
      const c = new pg.Client({ connectionString: WORKER_URL });
      await c.connect();
      await c.query("set role musebook_jobs");
      const loader = new PostgresWeightsLoader(sqlClient(c));
      const cohort = {
        family: "v1",
        viewerKind: "human",
        isNewUserForRanking: false,
        countryCode: null,
        surface: "home",
        experimentBucket: "exp:b0",
      } as const;
      const before = await loader.load(cohort);
      const adminW = new pg.Client({ connectionString: ADMIN_URL });
      await adminW.connect();
      try {
        await adminW.query(
          `update public.ranking_weights
              set weights = jsonb_set(weights, '{discrete,like}', '9999'::jsonb, true)
            where weights_version = 'v1'`,
        );
        const during = await loader.load(cohort);
        await adminW.query(
          `update public.ranking_weights
              set weights = jsonb_set(weights, '{discrete,like}', ($1)::jsonb, true)
            where weights_version = 'v1'`,
          [JSON.stringify(before.discrete.like ?? 0)],
        );
        const after = await loader.load(cohort);
        const changed =
          during.discrete.like === 9999 &&
          before.discrete.like !== 9999 &&
          during.totalSum !== before.totalSum &&
          after.discrete.like === before.discrete.like;
        console.log(
          changed
            ? `WEIGHTS_OK before=${before.discrete.like} during=${during.discrete.like} after=${after.discrete.like}`
            : `WEIGHTS_FAIL before=${before.discrete.like} during=${during.discrete.like} after=${after.discrete.like}`,
        );
      } finally {
        await Promise.allSettled([c.end(), adminW.end()]);
      }
      return;
    }

    if (sub === "p95") {
      // §16.7 M13.4: feed read p95 — the request path's ONE select, locally.
      // The edge request path calls app.read_slate_doc as musebook_worker
      // (EXECUTE binds to the session user; kernel enters planes inside the
      // function). Slates itself is jobs-plane only — resolve the row on the
      // admin connection first.
      const c = new pg.Client({ connectionString: WORKER_URL });
      await c.connect();
      const { rows } = await admin.query<{
        slate_id: string;
        surface: string;
        viewer: string;
      }>(
        `select id as slate_id, surface, viewer_user_id as viewer
           from public.slates
          where viewer_user_id is not null and surface = 'home'
            and candidate_count > 0
          order by created_at desc limit 1`,
      );
      if (rows.length === 0) {
        console.log("P95_FAIL no viewer home slate exists — run 'build' first");
        process.exitCode = 1;
        return;
      }
      const { slate_id, surface, viewer } = rows[0];
      const times: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        await c.query(
          "select app.read_slate_doc($1::uuid, null::uuid, $2, $3::uuid, -1, 100, null::uuid)",
          [viewer, surface, slate_id],
        );
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.floor(times.length * 0.95)];
      console.log(`P95_MS ${p95.toFixed(1)} n=${times.length}`);
      await c.end();
      return;
    }

    if (sub === "embed-tick") {
      // §16.7 M13.5's "one hourly tick": the real tick is backfillPostEmbeddings
      // (§9.23 verbatim CTE, enqueue) + consumeEmbedBatch (claim → dedupe → one
      // gateway call → record_embeddings). Locally there is no AI gateway, so
      // the fetch seam is stubbed exactly the way queue-idempotency.test.ts
      // stubs it — one deterministic 1536-dim vector per input.
      const { consumeEmbedBatch } = await import("../src/consumers/embed.js");
      // Two statements: a data-modifying CTE's rows are not visible to the
      // outer query's snapshot, so the queued select must run separately.
      await admin.query(
        `with todo as (
           select p.id, p.content_hash
             from public.posts p
             left join public.post_embeddings e on e.content_hash = p.content_hash
            where p.status = 'published' and p.deleted_at is null and e.content_hash is null
            order by p.published_at asc
            limit 2000
         )
         insert into public.job_outbox (kind, dedupe_key, payload)
         select 'embed', 'embed:' || todo.content_hash,
                jsonb_build_object('post_id', todo.id, 'content_hash', todo.content_hash)
           from todo
         on conflict (kind, dedupe_key) do nothing`,
      );
      const { rows } = await admin.query<{ id: number }>(
        "select id from public.job_outbox where kind = 'embed' and state = 'queued' order by id",
      );
      if (process.env["M13_DEBUG"] === "1") console.log(`DEBUG enqueued=${rows.length}`);
      if (rows.length > 0) {
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (_i: unknown, init?: { body?: string }) => {
          const texts = (JSON.parse(init?.body ?? "{}") as { input?: string[] }).input ?? [];
          return new Response(
            JSON.stringify({
              data: texts.map((t) => ({
                embedding: Array.from(
                  { length: 1536 },
                  (_, d) => ((t.charCodeAt(d % t.length) * (d + 7)) % 10000) / 10000,
                ),
              })),
            }),
            { status: 200 },
          );
        }) as typeof fetch;
        try {
          const env = {
            HYPERDRIVE_FRESH: { connectionString: WORKER_URL },
            AI_GATEWAY_API_KEY: "test",
            EMBEDDING_MODEL: "text-embedding-3-small",
            EMBEDDING_DIMENSIONS: "1536",
          } as unknown as Env;
          const messages = rows.map((r) => ({
            body: { job_id: Number(r.id) },
            ack: () => {},
            retry: () => {},
          }));
          await consumeEmbedBatch(
            {
              queue: "musebook-embed",
              messages,
              ackAll: () => {},
              retryAll: () => {},
            } as unknown as MessageBatch,
            env,
          );
          if (process.env["M13_DEBUG"] === "1") {
            const { rows: st } = await admin.query(
              "select state, attempts, last_error from public.job_outbox where kind='embed' order by id desc limit 3",
            );
            console.log(`DEBUG jobs=${JSON.stringify(st)}`);
          }
        } finally {
          globalThis.fetch = realFetch;
        }
      }
      const { rows: counts } = await admin.query<{ posts: number; emb: number }>(
        `select (select count(distinct p.content_hash) from public.posts p
                   join public.post_bodies b on b.content_hash = p.content_hash
                  where p.status = 'published') as posts,
                (select count(*) from public.post_embeddings) as emb`,
      );
      const { posts, emb } = counts[0];
      console.log(
        posts === emb
          ? `EMBED_OK embeddings=${emb} published=${posts}`
          : `EMBED_FAIL embeddings=${emb} published=${posts}`,
      );
      return;
    }

    console.error(`unknown sub-command: ${sub}`);
    process.exitCode = 2;
  } finally {
    await admin.end();
  }
}

await main();
