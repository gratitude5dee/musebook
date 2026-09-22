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

const API = "https://api.cloudflare.com/client/v4";
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
//    confirm", which reports drift so a human verifies in the dashboard.
const bot = await cf(`/zones/${ZONE}/bot_management`).catch(() => null);
if (bot === null) {
  drifts.push({
    name: "bot_management (unreadable)",
    want: "fight_mode:false, ai_bots agent=allow search=allow",
    got: "endpoint not readable with this token/zone tier — verify in dashboard",
    apply: async () => {},
  });
} else {
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

// 3. Pay-per-crawl fenced off: a Configuration Rule disabling it on the money
//    paths even if the zone-level toggle is ever flipped.
const rulesets = await cf(`/zones/${ZONE}/rulesets`).catch(() => []);
const hasPpcFence = JSON.stringify(rulesets ?? []).includes("disable-ppc-x402-paths");
await expectSetting(
  "ruleset disable-ppc-x402-paths",
  "present",
  hasPpcFence ? "present" : "absent",
  async () => {
    const entrypoints = await cf(
      `/zones/${ZONE}/rulesets/phases/http_config_settings/entrypoint`,
    ).catch(() => null);
    const existing = entrypoints?.rules ?? [];
    const rule = {
      description: "disable-ppc-x402-paths",
      expression:
        '(http.request.uri.path matches "^/p/" or http.request.uri.path matches "^/api/" or http.request.uri.path matches "^/mcp" or http.request.uri.path matches "^/media/")',
      action: "set_config",
      action_parameters: { pay_per_crawl: false },
      enabled: true,
    };
    await cf(`/zones/${ZONE}/rulesets/phases/http_config_settings/entrypoint`, {
      method: "PUT",
      body: JSON.stringify({
        rules: [...existing.filter((r: any) => r.description !== "disable-ppc-x402-paths"), rule],
      }),
    });
  },
);

// 4. Cache rules (§15): never override_origin on a gated prefix; deception
//    armor everywhere HTML is cacheable. Recorded as assertions on the
//    http_request_cache_settings ruleset.
const cacheRules = await cf(
  `/zones/${ZONE}/rulesets/phases/http_request_cache_settings/entrypoint`,
).catch(() => null);
const cacheText = JSON.stringify(cacheRules?.rules ?? []);
await expectSetting(
  "no override_origin edge-ttl on gated paths",
  "absent",
  /override_origin.*(gated|\/p\/|\/api\/)/is.test(cacheText) ? "present" : "absent",
  async () => {},
);

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
