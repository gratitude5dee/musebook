// scripts/gates/edge-routes.mjs — gate check `edge-routes` (G-EDGE-ROUTES,
// §6.12 / §7.10 / §3.6.1). Two assertions:
//
//   1. Every path in §6's gated-path list (§7.10's surface table: what the
//      Worker serves or gates) is matched by a `routes` pattern in
//      apps/edge/wrangler.jsonc. An unmatched gated path is served by the CDN
//      straight from Vercel — no gate, no 402, no telemetry. It looks fine.
//   2. None of the deliberately-Worker-free paths match: `/_next/static/*`,
//      `/_next/image*`, `/_vercel/*` (the ~7x billed-request lever), and
//      `origin.musebook.dev/*` (the grey-clouded break-glass bypass).
//
// Cloudflare route-pattern semantics implemented here: a pattern is
// `host/path`; `*` in either part matches any run of characters (including
// none). A pattern with no `/` is host-only and matches every path on that
// host. Host `*.x` matches any subdomain depth; a bare host matches itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

// String-aware comment stripper — a bare regex would eat `postgres://` inside
// string literals (same shape as readJsonc in checks.mjs).
const readJsonc = (path) => {
  const s = readFileSync(path, "utf8");
  const out = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out.push(c);
      if (c === "\\") out.push(s[++i]);
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out.push(c);
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
    } else {
      out.push(c);
    }
  }
  return JSON.parse(out.join(""));
};

const { routes = [] } = readJsonc(join(ROOT, "apps/edge/wrangler.jsonc"));
const patterns = routes.map((r) => (typeof r === "string" ? r : r.pattern));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toRe = (pattern) => {
  const p = String(pattern).replace(/^https?:\/\//, "");
  const slash = p.indexOf("/");
  const host = slash === -1 ? p : p.slice(0, slash);
  const path = slash === -1 ? "/*" : p.slice(slash);
  const hostRe = host.startsWith("*.")
    ? `(.+\\.)?${esc(host.slice(2))}`
    : esc(host).replaceAll("\\*", ".*");
  const pathRe = esc(path).replaceAll("\\*", ".*");
  return new RegExp(`^${hostRe}::${pathRe}$`);
};
const res = patterns.map(toRe);
const matches = (host, path) => res.some((re) => re.test(`${host}::${path}`));

// §7.10's surface table, one concrete instance per row — the canonical list.
const REQUIRED = [
  ["musebook.dev", "/"],
  ["musebook.dev", "/p/seed-article-free"],
  ["musebook.dev", "/p/seed-article-free.md"],
  ["musebook.dev", "/p/seed-article-free.json"],
  ["musebook.dev", "/p/seed-article-free.jsonld"],
  ["musebook.dev", "/@seed-author"],
  ["musebook.dev", "/@seed-author.md"],
  ["musebook.dev", "/@seed-author/feed.xml"],
  ["musebook.dev", "/feed.xml"],
  ["musebook.dev", "/feed.json"],
  ["musebook.dev", "/api/events"],
  ["musebook.dev", "/api/x402/charge"],
  ["musebook.dev", "/api/auth/login"],
  ["musebook.dev", "/api/media/webhook"],
  ["musebook.dev", "/llms.txt"],
  ["musebook.dev", "/llms-full.txt"],
  ["musebook.dev", "/.well-known/security.txt"],
  ["musebook.dev", "/authors.md"],
  ["musebook.dev", "/atom.xml"],
  ["musebook.dev", "/robots.txt"],
  ["musebook.dev", "/sitemap.xml"],
  ["musebook.dev", "/sitemap-1.xml"],
  ["musebook.dev", "/security.txt"],
  ["musebook.dev", "/crawlers.json"],
  ["www.musebook.dev", "/"],
  ["www.musebook.dev", "/p/seed-article-free"],
  ["media.musebook.dev", "/media/clip.mp4"],
  ["artifacts.musebook.dev", "/bundle/index.html"],
];

const FORBIDDEN = [
  ["musebook.dev", "/_next/static/chunks/app.js"],
  ["musebook.dev", "/_next/image"],
  ["musebook.dev", "/_vercel/image"],
  ["musebook.dev", "/_vercel/insights/script.js"],
  ["origin.musebook.dev", "/p/seed-article-free"],
  ["origin.musebook.dev", "/"],
];

const errors = [];
for (const [h, p] of REQUIRED)
  if (!matches(h, p)) errors.push(`gated path '${h}${p}' matches no route pattern`);
for (const [h, p] of FORBIDDEN)
  if (matches(h, p)) errors.push(`Worker-free path '${h}${p}' is routed through the Worker`);

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(
  `OK edge-routes: ${REQUIRED.length} gated paths covered, ${FORBIDDEN.length} exclusions held`,
);
