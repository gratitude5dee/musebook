// G-AXE / M7 e2e harness — a real browser against the real Worker against the
// real Next (§14.5.4, M7 gate 10). The Worker is wrangler dev with Hyperdrive's
// localConnectionString (local supabase); the origin is `next dev` on :3310
// reached over ORIGIN_SCHEME=http (the var no deployed wrangler.jsonc sets).
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const WEB_PORT = 3310;
const EDGE_PORT = 8787;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;
const EDGE_BASE = `http://127.0.0.1:${EDGE_PORT}`;
const EDGE_SECRET = "e2e-edge-secret-0000000000000000";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_DIR = join(HERE, "../.."); // apps/web
const REPO_ROOT = join(HERE, "../../../..");

// R2 presign vars ride the process env (the gate sources .env); absent values
// are simply not passed — the uploads route then answers r2_*_failed, which
// the compose spec will report honestly rather than hiding.
const r2Vars = ["CF_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "X402_PAY_TO"]
  .map((n) => (process.env[n] ? ` --var "${n}:${process.env[n]}"` : ""))
  .join("");
// Gated posts write x402_quotes.pay_to; e2e needs any syntactically valid
// treasury address when the env has none.
const x402PayToVar = process.env.X402_PAY_TO
  ? ""
  : ' --var "X402_PAY_TO:0x3333333333333333333333333333333333333333"';

// The local service key is the supabase CLI's own output — never a literal in
// the repo (push protection scans for the sb_secret_ shape).
const supabaseSecret = (): string => {
  if (process.env.SUPABASE_SECRET_KEY) return process.env.SUPABASE_SECRET_KEY;
  const out = execSync("pnpm exec supabase status -o env", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const m = /^SECRET_KEY="([^"]+)"/m.exec(out);
  const key = m?.[1];
  if (key === undefined) throw new Error("supabase status -o env: SECRET_KEY not found");
  return key;
};

export const EDGE_ORIGIN = EDGE_BASE;
export const SEED_COOKIE = "__Host-mb_session=musebook-seed-session-token-0001";

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  fullyParallel: false,
  workers: 2,
  reporter: [["line"]],
  use: {
    baseURL: EDGE_BASE,
    headless: true,
  },
  webServer: [
    {
      command: `pnpm exec next start -p ${WEB_PORT} --hostname 127.0.0.1`,
      cwd: WEB_DIR,
      url: `${WEB_BASE}/reels`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
        NEXT_PUBLIC_SITE_URL: EDGE_BASE,
        SUPABASE_SECRET_KEY: supabaseSecret(),
        SUPABASE_JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
        MUSEBOOK_EDGE_SECRET: EDGE_SECRET,
      },
    },
    {
      command: `pnpm --dir ${REPO_ROOT}/apps/edge exec wrangler dev --port ${EDGE_PORT} --ip 127.0.0.1 --var "ORIGIN_HOST:127.0.0.1:${WEB_PORT}" --var "ORIGIN_SCHEME:http" --var "MUSEBOOK_EDGE_SECRET:${EDGE_SECRET}"${r2Vars}${x402PayToVar}`,
      cwd: REPO_ROOT,
      url: `${EDGE_BASE}/reels`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
