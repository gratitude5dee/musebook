// apps/worker/scripts/m14-classify-probe.mts — the M14 gate's live probes.
// Runs the production call path (worker-scoped classification_state → real
// TypeSafeClient → classifyOne) against the local Supabase and prints one
// PASS/FAIL line per sub-check. Invoked by scripts/gates/checks.mjs.
//
//   tsx scripts/m14-classify-probe.mts versions
//   tsx scripts/m14-classify-probe.mts battery
import pg from "pg";
import {
  classifyOne,
  makeClient,
  QUESTION_SET_VERSION,
  TAXONOMY_VERSION,
  truncateBody,
  type PostState,
} from "@musebook/classify";

const WORKER_URL = "postgres://musebook_worker:postgres@127.0.0.1:54322/postgres";
const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

async function versions() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    // The OPERATIONS.md deploy step, locally: the version row is what the
    // backfill predicate joins (Supabase roles cannot SET database-level GUCs,
    // so classify_versions is the registry).
    await admin.query(
      `insert into public.classify_versions
         (singleton, question_set_version, taxonomy_version, updated_at)
       values (true, $1, $2, now())
       on conflict (singleton) do update set
         question_set_version = excluded.question_set_version,
         taxonomy_version = excluded.taxonomy_version,
         updated_at = now()`,
      [QUESTION_SET_VERSION, TAXONOMY_VERSION],
    );
    const {
      rows: [row],
    } = await admin.query<{ ok: boolean; qs_match: boolean; tax_match: boolean }>(
      `select question_set_version <> '' as ok,
              question_set_version = $1 as qs_match,
              taxonomy_version = $2 as tax_match
         from public.classify_versions`,
      [QUESTION_SET_VERSION, TAXONOMY_VERSION],
    );
    if (!row?.ok || !row.qs_match || !row.tax_match)
      throw new Error(`classify_versions row wrong or absent: ${JSON.stringify(row)}`);
    const {
      rows: [missing],
    } = await admin.query<{ n: number }>(
      `select count(*)::int as n from public.post_classifications
        where provider in ('typesafe_jev','ai_gateway')
          and (question_set_version is null or question_set_version = ''
            or taxonomy_version is null or taxonomy_version = '')`,
    );
    if (missing.n !== 0) throw new Error(`${missing.n} classifier rows carry empty version stamps`);
    console.log("VERSIONS_OK");
  } finally {
    await admin.end();
  }
}

async function battery() {
  const provider = process.env.CLASSIFY_PROVIDER ?? "typesafe";
  const key =
    provider === "gateway" ? process.env.AI_GATEWAY_API_KEY : process.env.TYPESAFE_API_KEY;
  if (!key) {
    console.log(
      `BATTERY_BLOCKED no ${provider === "gateway" ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY"}`,
    );
    process.exit(2);
  }
  const worker = new pg.Client({ connectionString: WORKER_URL });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await Promise.all([worker.connect(), admin.connect()]);
  try {
    const { rows: posts } = await admin.query<{ content_hash: string }>(
      `select content_hash from public.posts
        where status = 'published' and deleted_at is null
          and title like 'Seed %'          -- the deterministic corpus; gate-test litter is out of scope
        order by created_at`,
    );
    if (posts.length === 0) throw new Error("no published posts seeded");
    const env = {
      CLASSIFY_PROVIDER: provider,
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      TYPESAFE_DEFAULT_MODEL: process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest",
      AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
      CLASSIFY_MODEL: process.env.CLASSIFY_MODEL ?? "anthropic/claude-haiku-4.5",
      CLASSIFY_TAXONOMY_MODE: process.env.CLASSIFY_TAXONOMY_MODE ?? "walk",
      ...(process.env.TYPESAFE_BASE_URL
        ? { TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL }
        : {}),
    };
    const modelSlug = provider === "gateway" ? env.CLASSIFY_MODEL : env.TYPESAFE_DEFAULT_MODEL;
    const client = makeClient(env);
    const misses: string[] = [];
    for (const { content_hash } of posts) {
      const {
        rows: [s],
      } = await worker.query<{ state: Omit<PostState, "link_hosts"> | null }>(
        `select app.classification_state($1,$2,$3,$4,$5) as state`,
        [
          content_hash,
          QUESTION_SET_VERSION,
          TAXONOMY_VERSION,
          modelSlug,
          true, // force — the probe measures the battery, not the cache
        ],
      );
      const raw = s?.state;
      if (raw == null) {
        misses.push(`${content_hash.slice(0, 12)} no-state`);
        continue;
      }
      const state: PostState = {
        ...raw,
        body: truncateBody(raw.body),
        link_hosts: [],
      };
      const { narrow } = await classifyOne(client, env, content_hash, state, Date.now());
      if (
        narrow.taxonomy_leaf == null ||
        narrow.medium == null ||
        narrow.audience_level == null ||
        narrow.agent_value == null
      )
        misses.push(
          `${content_hash.slice(0, 12)} leaf=${narrow.taxonomy_leaf} medium=${narrow.medium}`,
        );
    }
    if (misses.length) throw new Error(`battery misses: ${misses.join("; ")}`);
    console.log(`BATTERY_OK ${posts.length}`);
  } finally {
    await Promise.allSettled([worker.end(), admin.end()]);
  }
}

const sub = process.argv[2];
try {
  if (sub === "versions") await versions();
  else if (sub === "battery") await battery();
  else throw new Error(`unknown subcommand ${sub}`);
} catch (e) {
  console.log(`${(sub ?? "?").toUpperCase()}_FAIL ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
