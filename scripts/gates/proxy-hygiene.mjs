// scripts/gates/proxy-hygiene.mjs — gate check `proxy-hygiene` (G-PROXY, §3.4,
// §6.12). Origin-auth enforcement and twin rewrites. Static analysis of
// proxy.ts's shape — the runtime probe lands with the real proxy at M6.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const errors = [];

const proxyPath = join(ROOT, "apps/web/proxy.ts");
const mwPath = join(ROOT, "apps/web/middleware.ts");

if (existsSync(mwPath)) {
  errors.push(
    "apps/web/middleware.ts exists — Next 16 hard-throws when proxy.ts is also present; it must never come back",
  );
}
if (!existsSync(proxyPath)) {
  errors.push(
    "apps/web/proxy.ts is missing — the origin lockdown is the only thing in front of the paywall",
  );
} else {
  const src = readFileSync(proxyPath, "utf8");
  const has = (re, why) => {
    if (!re.test(src)) errors.push(`proxy.ts: ${why}`);
  };
  const hasNot = (re, why) => {
    if (re.test(src)) errors.push(`proxy.ts: ${why}`);
  };

  // 1. Exports `proxy`, never `middleware`, and no route-segment runtime.
  has(
    /export\s+(async\s+)?function\s+proxy\b/,
    "must export a `proxy` function — `middleware` is rejected by Next 16 when the file is named proxy.ts",
  );
  hasNot(/export\s+(async\s+)?function\s+middleware\b/, "must not export `middleware`");
  hasNot(
    /runtime\s*:\s*["'](?:nodejs|edge)["']/,
    "route-segment config is not allowed in a Proxy file — Proxy always runs on Node",
  );

  // 2. Origin auth: header read, timing-safe compare, 404 on miss.
  has(/x-musebook-edge/, "must read the `x-musebook-edge` header");
  has(/MUSEBOOK_EDGE_SECRET/, "must compare against MUSEBOOK_EDGE_SECRET");
  has(/MUSEBOOK_EDGE_SECRET_PREVIOUS/, "must accept the _PREVIOUS slot during rotation (§3.11)");
  has(
    /timingSafeEqual|safeEqual|timing-safe|constant.?time/i,
    "the secret comparison must be timing-safe",
  );
  has(
    /\b404\b/,
    "an unauthenticated origin request answers 404, not 401/403 — a 403 confirms the host is real",
  );
  has(
    /VERCEL_ENV/,
    "must skip origin auth when VERCEL_ENV !== 'production' or every Vercel preview 404s (§3.10)",
  );

  // 3. Never strips an x-mb-* header — they carry the Worker's plane
  //    decision to the origin; removing one un-gates a response.
  hasNot(
    /\.(delete|set)\s*\(\s*["'`]x-mb-/i,
    "must never delete or overwrite an x-mb-* header — they carry the Worker's plane decision to the origin",
  );

  // 4. matcher covers everything.
  has(
    /matcher\s*:\s*\[\s*["'`]\/:path\*["'`]/,
    "config.matcher must cover '/:path*' — a partial matcher leaves some paths unauthenticated",
  );
}

for (const e of errors) console.error(`::error::${e}`);
if (errors.length) process.exit(1);
console.log("proxy-hygiene ok: proxy.ts enforces the origin lockdown");
