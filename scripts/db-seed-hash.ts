// scripts/db-seed-hash.ts — writes supabase/SEED_HASH: the sha256 of the
// ordered data-only dump of the public schema after `supabase db reset`.
// Run once when the seed lands (M2); G-SEED reproduces it twice at every gate.
//
// Remote:  SUPABASE_DB_URL=<direct url> pnpm db:seed-hash   (reset --linked)
// Local:   pnpm db:seed-hash                                (reset --local,
//          pg_dump inside the supabase_db container)
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const dbUrl = process.env.SUPABASE_DB_URL ?? LOCAL_DB_URL;
const local = /127\.0\.0\.1|localhost/.test(dbUrl);

const container = (): string => {
  const out = execSync("docker ps --format '{{.Names}}' --filter name=supabase_db | head -1", {
    encoding: "utf8",
  }).trim();
  if (!out) {
    console.error("db:seed-hash: no supabase_db container and no host pg_dump");
    process.exit(2);
  }
  return out;
};

const hasPgDump = (): boolean => {
  try {
    execSync("command -v pg_dump", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const target = local ? "--local" : "--linked";
console.log(`db:seed-hash: supabase db reset ${target}`);
execSync(`pnpm exec supabase db reset ${target}`, { stdio: "inherit" });

// `db reset` returns after issuing an async container restart — wait for
// postgres to accept connections or the dump races a still-booting server.
if (!hasPgDump() && local)
  execSync(`until docker exec ${container()} pg_isready -U postgres -q; do sleep 1; done`);

let hash: string;
if (hasPgDump()) {
  hash = execSync(
    `pg_dump --data-only --schema=public ${JSON.stringify(dbUrl)} | grep -vE '^\\\\(un)?restrict ' | LC_ALL=C sort | sha256sum | cut -d" " -f1`,
    { encoding: "utf8" },
  ).trim();
} else if (local) {
  hash = execSync(
    `docker exec ${container()} pg_dump -U postgres -d postgres --data-only --schema=public | grep -vE '^\\\\(un)?restrict ' | LC_ALL=C sort | sha256sum | cut -d" " -f1`,
    { encoding: "utf8" },
  ).trim();
} else {
  console.error("db:seed-hash: remote URL but no pg_dump on PATH");
  process.exit(2);
}

writeFileSync("supabase/SEED_HASH", hash + "\n");
console.log(`supabase/SEED_HASH <- ${hash}`);
