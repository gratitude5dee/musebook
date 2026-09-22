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
import pg from "pg";

export default async function setup() {
  const client = new pg.Client({
    connectionString: "postgres://postgres:postgres@127.0.0.1:54322/postgres",
  });
  await client.connect();
  try {
    await client.query("alter role musebook_worker password 'postgres'");
  } finally {
    await client.end();
  }
}
