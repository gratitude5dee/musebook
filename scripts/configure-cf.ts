// scripts/configure-cf.ts — musebook.dev zone settings as code (§3.10, §15).
//   tsx scripts/configure-cf.ts          # apply: bring the zone to the desired state
//   tsx scripts/configure-cf.ts --check  # read-only: report drift, exit 1 on any
//
// Why these settings are here and not in a dashboard: Bot Fight Mode overrides
// every rule below it and cannot be skipped; the 2026-09-15 new-zone default
// blocks Agent-classified bots on ad-displaying pages; pay-per-crawl is fenced
// OFF by a Configuration Rule because it is economically incompatible with
// x402 (§3.7). All three silently break the money path if wrong.
//
// Credentials: CF_API_TOKEN (read-only + zone-settings scope) + CF_ZONE_ID.
// NOT CLOUDFLARE_API_TOKEN — the deploy token is a different, broader secret.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.cloudflare.com/client/v4";
const ROOT = new URL("..", import.meta.url).pathname;
const ZONE = process.env.CF_ZONE_ID;
const TOKEN = process.env.CF_API_TOKEN;
const CHECK = process.argv.includes("--check");

if (!ZONE || !TOKEN) {
  console.error(
    "configure-cf: CF_ZONE_ID and CF_API_TOKEN are required (scope: zone settings read/edit)",
  );
  process.exit(2);
}

async function cf(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || (body && body.success === false)) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 400)}`,
    );
  }
  return body?.result ?? body;
}

interface Drift {
  name: string;
  want: string;
  got: string;
  apply: () => Promise<void>;
}

const drifts: Drift[] = [];

async function expectSetting(
  name: string,
  want: unknown,
  got: unknown,
  apply: () => Promise<void>,
) {
  const w = JSON.stringify(want);
  const g = JSON.stringify(got);
  if (w !== g) drifts.push({ name, want: w, got: g, apply });
}

// 1. SSL mode: Full (strict). Set BEFORE the apex record exists — Flexible is
//    a guaranteed redirect loop against Vercel's unconditional 308 (O6).
const ssl = await cf(`/zones/${ZONE}/settings/ssl`);
await expectSetting("ssl.value", "strict", ssl?.value, async () => {
  await cf(`/zones/${ZONE}/settings/ssl`, {
    method: "PATCH",
    body: JSON.stringify({ value: "strict" }),
  });
});

// 2. Bot Fight Mode OFF (it overrides everything and cannot be skipped by a
//    rule). UNVERIFIED key on Free/Pro zones — absence is treated as "cannot
//    confirm", which reports drift so a human verifies in the dashboard. Once
//    verified, the record lives in OPERATIONS.md as `- attested bot-management`
//    and substitutes for the unreadable endpoint — the live read is still
//    preferred whenever the API offers it.
const opsText = existsSync(join(ROOT, "OPERATIONS.md"))
  ? readFileSync(join(ROOT, "OPERATIONS.md"), "utf8")
  : "";
const botAttested = /-\s*attested\s+bot-management\b/i.test(opsText);
const bot = await cf(`/zones/${ZONE}/bot_management`).catch(() => null);
if (bot === null && !botAttested) {
  drifts.push({
    name: "bot_management (unreadable)",
    want: "fight_mode:false, ai_bots agent=allow search=allow",
    got: "endpoint not readable with this token/zone tier — verify in dashboard",
    apply: async () => {},
  });
} else if (bot !== null) {
  await expectSetting("bot_management.fight_mode", false, bot?.fight_mode, async () => {
    await cf(`/zones/${ZONE}/bot_management`, {
      method: "PUT",
      body: JSON.stringify({ ...bot, fight_mode: false }),
    });
  });
  const ai = bot?.ai_bots ?? {};
  await expectSetting("ai_bots.agent", "allow", ai.agent, async () => {
    await cf(`/zones/${ZONE}/bot_management`, {
      method: "PUT",
      body: JSON.stringify({ ...bot, ai_bots: { ...ai, agent: "allow", search: "allow" } }),
    });
  });
  await expectSetting("ai_bots.search", "allow", ai.search, async () => {});
}

// 3. Pay-per-crawl: there is no surface to fence. The `pay_per_crawl` action
//    parameter is rejected by http_config_settings on this account and no
//    /zones/{id}/{ai_crawl,ppc,pay_per_crawl} endpoint exists — PPC is closed
//    private beta and cannot be enabled here (§6.12.6). The drift item is the
//    surface *appearing*: if a PPC endpoint ever answers 200, a human must
//    ensure it is never set to charge.
const ppcProbe = await Promise.all(
  ["ai_crawl", "aibot", "ppc", "pay_per_crawl", "ai_crawl_control"].map((p) =>
    fetch(`${API}/zones/${ZONE}/${p}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
      .then((r) => ({ p, status: r.status }))
      .catch(() => ({ p, status: 0 })),
  ),
);
const ppcSurface = ppcProbe.filter((x) => x.status === 200).map((x) => x.p);
await expectSetting(
  "pay-per-crawl surface",
  "absent",
  ppcSurface.length === 0 ? "absent" : `present on ${ppcSurface.join(",")}`,
  async () => {},
);

// 4. Cache rules (§15): one http_request_cache_settings ruleset, three rules
//    in this order — (a) bypass on the money headers and /api/x402 + /mcp
//    (Cloudflare honours an arbitrary Vary only through a bypass rule, so this
//    is what actually separates the two planes of human_free_agent_paid);
//    (b) /_next/image + /_vercel/image, extension-less and therefore DYNAMIC
//    without a rule — every image request would bill Vercel forever — with a
//    custom cache key on url/w/q and cache_deception_armor on; (c) Cache
//    Everything + Edge TTL on cdn.musebook.dev because default caching is
//    extension-based and skips .m3u8, .ts and .json. cdn. is the public bucket
//    — never a gated prefix — so override_origin is safe there and nowhere else.
const wantCacheRules = [
  {
    description: "bypass-cache-x402-money-headers",
    expression:
      'starts_with(http.request.uri.path, "/api/x402") or starts_with(http.request.uri.path, "/mcp") or len(http.request.headers["payment-signature"]) > 0 or len(http.request.headers["signature-agent"]) > 0',
    action: "set_cache_settings",
    action_parameters: { cache: false },
    enabled: true,
  },
  {
    description: "cache-next-image",
    expression:
      'starts_with(http.request.uri.path, "/_next/image") or starts_with(http.request.uri.path, "/_vercel/image")',
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      // §16.5 M6.29 asks for a custom_key on url/w/q. `custom_key` is an
      // Enterprise entitlement this zone doesn't have — but the DEFAULT key
      // already includes host + path + full query string, and /_next/image
      // emits only url/w/q, so the key it wants is the key it gets. Deviation
      // recorded in DEVIATIONS.md; the gate check asserts custom_key OR
      // default-key-equivalence.
      cache_key: { cache_deception_armor: true },
    },
    enabled: true,
  },
  {
    description: "cache-everything-cdn",
    expression: 'http.host eq "cdn.musebook.dev"',
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      // cdn. objects are content-keyed and immutable; 30d edge TTL. §15's
      // override_origin ban is for gated path prefixes — this host can only
      // serve the public bucket.
      edge_ttl: { mode: "override_origin", default: 2592000 },
    },
    enabled: true,
  },
];

const cacheRules = await cf(
  `/zones/${ZONE}/rulesets/phases/http_request_cache_settings/entrypoint`,
).catch(() => null);
const existingCacheRules: any[] = cacheRules?.rules ?? [];
const rulePresent = (want: any) =>
  existingCacheRules.some((r) => r.description === want.description && r.enabled);
const cacheText = JSON.stringify(existingCacheRules);

for (const want of wantCacheRules) {
  await expectSetting(
    `cache-rule ${want.description}`,
    "present",
    rulePresent(want) ? "present" : "absent",
    async () => {
      const rules = [
        ...existingCacheRules.filter(
          (r) => !wantCacheRules.some((w) => w.description === r.description),
        ),
        ...wantCacheRules,
      ];
      await cf(`/zones/${ZONE}/rulesets/phases/http_request_cache_settings/entrypoint`, {
        method: "PUT",
        body: JSON.stringify({ rules }),
      });
    },
  );
}

await expectSetting(
  "no override_origin edge-ttl on gated paths",
  "absent",
  /override_origin.*(gated|\/p\/|\/api\/)/is.test(cacheText) ? "present" : "absent",
  async () => {},
);

// Smart Tiered Cache on (Cache Reserve stays off — it is R2-priced storage in
// front of R2, duplicate cost for zero benefit, §15).
const tiered = await cf(`/zones/${ZONE}/cache/tiered_cache_smart_topology_enable`).catch(
  () => null,
);
await expectSetting("tiered_cache.smart_topology", "on", tiered?.value, async () => {
  await cf(`/zones/${ZONE}/cache/tiered_cache_smart_topology_enable`, {
    method: "PATCH",
    body: JSON.stringify({ value: "on" }),
  });
});

// Polish and Mirage OFF — both produce their own variants and are documented
// as incompatible with Vary-based variants (§15, §7.20 check 29).
const polish = await cf(`/zones/${ZONE}/settings/polish`).catch(() => null);
await expectSetting("polish", "off", polish?.value, async () => {
  await cf(`/zones/${ZONE}/settings/polish`, {
    method: "PATCH",
    body: JSON.stringify({ value: "off" }),
  });
});
const mirage = await cf(`/zones/${ZONE}/settings/mirage`).catch(() => null);
await expectSetting("mirage", "off", mirage?.value, async () => {
  await cf(`/zones/${ZONE}/settings/mirage`, {
    method: "PATCH",
    body: JSON.stringify({ value: "off" }),
  });
});

// ---------------------------------------------------------------------------

if (drifts.length === 0) {
  console.log("configure-cf: zero drift — zone is in the desired state");
  process.exit(0);
}

if (CHECK) {
  for (const d of drifts) console.error(`DRIFT ${d.name}: want ${d.want}, got ${d.got}`);
  console.error(`configure-cf --check: ${drifts.length} drift(s)`);
  process.exit(1);
}

console.log(`configure-cf: applying ${drifts.length} change(s)`);
for (const d of drifts) {
  console.log(`  ${d.name}: ${d.got} → ${d.want}`);
  await d.apply();
}
console.log("configure-cf: done");
