// scripts/db-seed-hash.ts — writes supabase/SEED_HASH: the sha256 of the
// ordered data-only dump of the public schema after `supabase db reset`.
// Run once when the seed lands (M2); G-SEED reproduces it twice at every gate.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("db:seed-hash: SUPABASE_DB_URL is required (direct connection, port 5432)");
  process.exit(2);
}

execSync("supabase db reset --linked", { stdio: "inherit" });
const hash = execSync(
  'pg_dump --data-only --schema=public "$SUPABASE_DB_URL" | LC_ALL=C sort | sha256sum | cut -d" " -f1',
  { encoding: "utf8" },
).trim();
writeFileSync("supabase/SEED_HASH", hash + "\n");
console.log(`supabase/SEED_HASH <- ${hash}`);
