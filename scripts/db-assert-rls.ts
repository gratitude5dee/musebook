// scripts/db-assert-rls.ts — G-ROLE. Runs §4.14's six posture blocks plus the
// live axis-B execution test as the real musebook_worker role.
//
//   pnpm db:assert-rls
//
// Env:
//   SUPABASE_DB_URL             admin connection (local default below)
//   MUSEBOOK_WORKER_DB_PASSWORD worker role password; applied idempotently via
//                               `alter role` before the live test (the §4.14
//                               out-of-band step), so a fresh clone just works.
//
// Exit 0 = pass. Any raised exception or failed assertion exits 1.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminUrl =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const workerPassword = process.env.MUSEBOOK_WORKER_DB_PASSWORD;

const sql = (rel: string) => readFileSync(path.join(root, rel), "utf8");

async function run(label: string, client: pg.Client, file: string): Promise<void> {
  try {
    await client.query(sql(file));
  } catch (e) {
    console.error(`FAIL ${label}: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`ok ${label}`);
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();

// ── posture blocks (admin): the six §4.14 assertions + §15.6.3 advisors ──────
await run("assert-rls (six blocks)", admin, "scripts/sql/assert-rls.sql");
await run("assert-no-anon-exposure", admin, "scripts/sql/assert-no-anon-exposure.sql");

// ── axis B: real musebook_worker connection ──────────────────────────────────
if (!workerPassword) {
  console.error(
    "FAIL MUSEBOOK_WORKER_DB_PASSWORD is not set — axis B must authenticate " +
      "as musebook_worker (running as postgres would pass everything, which " +
      "is exactly the finding).",
  );
  process.exit(1);
}

// Idempotent out-of-band step: the role exists (migration 14) with LOGIN but
// no password; set it so the worker can authenticate. Not DDL drift — a role
// password is connection state, and `supabase db diff` does not report it.
await admin.query(`alter role musebook_worker password ${pg.escapeLiteral(workerPassword)}`);

const u = new URL(adminUrl);
const worker = new pg.Client({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: "musebook_worker",
  password: workerPassword,
  ssl: u.searchParams.get("sslmode") === "disable" ? false : undefined,
});
await worker.connect();
await run("axis B (musebook_worker planes)", worker, "scripts/sql/assert-rls-worker.sql");

await worker.end();

// Restore the localConnectionString convention (`postgres`) so the vitest
// tiers and manual dev sessions that follow axis B can still authenticate.
// Same out-of-band step as above — connection state, not schema drift.
await admin.query(`alter role musebook_worker password 'postgres'`);
await admin.end();
console.log("db:assert-rls PASS");
process.exit(0);
