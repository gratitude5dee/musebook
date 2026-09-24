// scripts/test/ensure-worker-role.mjs — vitest globalSetup for every tier
// that connects to the local Supabase as musebook_worker.
//
// `supabase db reset` restarts the postgres container and replays
// migrations, so migration 14 recreates musebook_worker LOGIN with NO
// password — the "create role" branch deliberately ships no credential
// (the real one lives in MUSEBOOK_WORKER_DB_PASSWORD, Hyperdrive-side).
// The wrangler localConnectionString convention is `postgres` for local
// dev, so before any test binds a Hyperdrive connection string the role
// must carry that password. This is connection state, not DDL drift —
// `supabase db diff` never reports a role password.
//
// It also ensures the local postgres admits the wire suites' fan-out:
// m8-wire replays one signed authorization 101 ways concurrently and each
// SELF.fetch opens its own connection, while Supabase's stock image boots
// at max_connections=100 with ~3 reserved for superuser. `db reset`
// recreates the container, so the conf.d drop can't live there — it is
// re-asserted here, per run, before the tier connects.
import { execSync } from "node:child_process";
import pg from "pg";

const CONTAINER = execSync("docker ps --format '{{.Names}}' --filter name=supabase_db | head -1", {
  encoding: "utf8",
}).trim();

const dockerPsql = (sql) =>
  execSync(`docker exec ${CONTAINER} psql -U postgres -d postgres -Atc ${JSON.stringify(sql)}`, {
    encoding: "utf8",
  }).trim();

async function ensureConnectionHeadroom() {
  if (!CONTAINER) return;
  const current = Number(dockerPsql("show max_connections"));
  if (current >= 200) return;
  execSync(
    `docker exec ${CONTAINER} sh -c ` +
      `'echo "max_connections = 500" > /etc/postgresql/postgresql.conf.d/zz-gate.conf'`,
  );
  execSync(`docker restart ${CONTAINER}`, { stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if (dockerPsql("select 1") === "1") return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error("supabase_db did not come back after max_connections bump");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export default async function setup() {
  await ensureConnectionHeadroom();
  const client = new pg.Client({
    connectionString: "postgres://postgres:postgres@127.0.0.1:54322/postgres",
  });
  await client.connect();
  try {
    await client.query("alter role musebook_worker password 'postgres'");
    // pg_cron is absent on the local/CI image, so the daily partition
    // schedule never fires — a fresh stack carries only the two bootstrap
    // leaves (20260922/23) and every now()-dated action_events write fails
    // ExecFindPartition. Hosted prod keeps 7 days ahead via the cron job;
    // the test harness asserts the same headroom once per run.
    await client.query("select app.ensure_action_event_partitions(7)");
  } finally {
    await client.end();
  }
}
