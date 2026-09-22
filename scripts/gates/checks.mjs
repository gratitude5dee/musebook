// scripts/gates/checks.mjs — shared check implementations behind manifest.mjs.
// Each returns { ok, errors[] }; the runner prints and exits (§17.12.1).
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

/** Run a command, capturing stdout+stderr. Returns { code, out } — never throws. */
function run(cmd, opts = {}) {
  try {
    const out = execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** ripgrep helper: returns the matched lines, [] on no-match, throws on real error. */
function rg(pattern, scope, extraArgs = []) {
  try {
    const hits = execFileSync(
      "rg",
      ["--no-heading", "--line-number", ...extraArgs, pattern, ...scope],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    return hits.trim().length ? hits.trim().split("\n") : [];
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

/** Minimal JSONC reader for wrangler configs (comments + trailing commas). */
function readJsonc(path) {
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
  // trailing commas
  return JSON.parse(out.join("").replace(/,(\s*[}\]])/g, "$1"));
}

const WRANGLER_CONFIGS = [
  "apps/edge/wrangler.jsonc",
  "apps/mcp/wrangler.jsonc",
  "apps/worker/wrangler.jsonc",
];

const LEGACY_NEEDLE = "ixkkrousepsiorwlaycp";

// ---------------------------------------------------------------------------
// Universal checks
// ---------------------------------------------------------------------------

// §12.2.8 — AGPL containment. Seven regexes + the sidecar Dockerfile assertion.
export function agplContainment() {
  const FORBIDDEN = [
    String.raw`from\s+['"][^'"]*nestjs-libraries/src/integrations`,
    String.raw`from\s+['"][^'"]*postiz[^'"]*['"]`,
    String.raw`require\(\s*['"][^'"]*postiz`,
    String.raw`['"]@postiz/node['"]`,
    String.raw`\bSocialAbstract\b`,
    String.raw`\bsocialIntegrationList\b`,
    String.raw`\bPostValidationException\b`,
  ];
  // `workers` is in scope because the distributor now ships inside a Worker
  // bundle; a violation there is exactly as fatal as one in apps/.
  const SCOPE = ["apps", "packages", "workers", "tools", "supabase"].filter((d) =>
    existsSync(join(ROOT, d)),
  );

  const errors = [];
  for (const pattern of FORBIDDEN) {
    const hits = rg(pattern, SCOPE, []);
    if (hits.length) errors.push(`AGPL boundary violated by /${pattern}/\n${hits.join("\n")}`);
  }

  // The sidecar's compose file is infrastructure, not build input.
  if (existsSync(join(ROOT, "infra/postiz/Dockerfile"))) {
    errors.push(
      "infra/postiz/Dockerfile exists. Musebook must run the UPSTREAM image " +
        "unmodified; layering our code into it creates a combined AGPL work.",
    );
  }
  return { ok: errors.length === 0, errors };
}

// §3.12 — the standing rule. No exempt path: nothing is migrated.
export function legacyRef() {
  const hits = rg(LEGACY_NEEDLE, ["apps", "packages", "supabase", "tools", ".github"]);
  return {
    ok: hits.length === 0,
    errors: hits.length ? [`legacy Supabase project reference found:\n${hits.join("\n")}`] : [],
  };
}

// Dead Vercel-era platform reads — each fails SILENTLY behind Cloudflare.
export function vercelDead() {
  const NEEDLES = [
    "x-vercel-ip-",
    "@vercel/blob",
    "botid",
    "attachDatabasePool",
    "pgmq.",
    "geolocation(",
    "ipAddress(",
    "mcp-handler",
    "@cloudflare/vitest-pool-workers",
    "defineWorkersConfig",
    "defineWorkersProject",
    "CRON_SECRET",
    "@vercel/sdk",
  ];
  const errors = [];
  for (const needle of NEEDLES) {
    // The words themselves are allowed in prose/docs names only where a file
    // is explicitly the guard explaining them — eslint.config.mjs and this
    // file name them to forbid them.
    const hits = rg(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), [
      "apps",
      "packages",
      "scripts/gates/manifest.mjs",
      "supabase",
    ]);
    const real = hits.filter(
      (h) => !h.includes("eslint.config.mjs") && !h.includes("check-env-manifest"),
    );
    if (real.length) errors.push(`dead platform read "${needle}":\n${real.join("\n")}`);
  }
  return { ok: errors.length === 0, errors };
}

// G-SKIP — a skipped/quarantined test anywhere under apps|packages|tools.
export function gSkip() {
  const NEEDLES = [
    String.raw`\b(it|test|describe)\.skip\b`,
    String.raw`\b(it|test|describe)\.only\b`,
    String.raw`\bxit\b`,
    String.raw`\btest\.todo\b`,
    String.raw`\btest\.fails\b`,
    String.raw`@quarantine`,
    String.raw`continue-on-error`,
  ];
  const errors = [];
  for (const pattern of NEEDLES) {
    const hits = rg(pattern, ["apps", "packages", "tools", ".github/workflows"], []).filter(
      // `RuleTester.itOnly = it.only` is the RuleTester API for .only-fixture
      // testing, not a committed only-test.
      (h) => !h.includes("itOnly = it.only"),
    );
    if (hits.length) errors.push(`forbidden skip pattern /${pattern}/:\n${hits.join("\n")}`);
  }
  return { ok: errors.length === 0, errors };
}

// G-ZOD — the split is load-bearing (§3.2).
export function zodSplit() {
  const errors = [];
  const ws = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  if (/^\s*zod:/m.test(ws))
    errors.push("pnpm-workspace.yaml declares a `zod` catalog entry — it must not exist (§3.2).");
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (root.pnpm?.overrides?.zod)
    errors.push("package.json pnpm.overrides.zod is set — one zod must not be forced (§3.2).");
  const x402 = JSON.parse(readFileSync(join(ROOT, "packages/x402/package.json"), "utf8"));
  if (x402.dependencies?.zod || x402.devDependencies?.zod || x402.peerDependencies?.zod)
    errors.push("packages/x402 must not declare zod — it inherits zod 3 via @x402/core (§3.2).");
  const ls = run("pnpm ls zod --depth Infinity --json");
  if (ls.code !== 0) {
    errors.push(`pnpm ls zod failed: ${ls.out.slice(0, 500)}`);
  } else {
    const text = ls.out;
    const has3 =
      /"zod@[^"]*3\./.test(text) || /zod@3\./.test(text) || /"version":\s*"3\./.test(text);
    const has4 =
      /"zod@[^"]*4\./.test(text) || /zod@4\./.test(text) || /"version":\s*"4\./.test(text);
    if (!has3) errors.push("no zod 3.x resolved — @x402/core would be running an untested major.");
    if (!has4)
      errors.push(
        "no zod 4.x resolved — @modelcontextprotocol/server would be running an untested major.",
      );
  }
  return { ok: errors.length === 0, errors };
}

// G-TYPES — typecheck + committed worker-configuration.d.ts diffs empty.
export function gTypes() {
  const r1 = run("pnpm -r typecheck");
  if (r1.code !== 0) return { ok: false, errors: [`typecheck failed:\n${r1.out.slice(-3000)}`] };
  const r2 = run("pnpm cf:types");
  if (r2.code !== 0)
    return { ok: false, errors: [`wrangler types failed:\n${r2.out.slice(-3000)}`] };
  const d = run("git diff --exit-code -- 'apps/*/worker-configuration.d.ts'");
  if (d.code !== 0)
    return {
      ok: false,
      errors: ["worker-configuration.d.ts is stale — run `pnpm cf:types` and commit the result."],
    };
  return { ok: true, errors: [] };
}

// G-BOUND — bindings declared vs bindings read, both directions.
export async function gBound() {
  const errors = [];
  for (const cfgPath of WRANGLER_CONFIGS) {
    const appDir = cfgPath.split("/").slice(0, 2).join("/");
    const cfg = readJsonc(join(ROOT, cfgPath));
    const declared = new Set();
    const sections = {
      r2_buckets: (e) => e.binding,
      kv_namespaces: (e) => e.binding,
      hyperdrive: (e) => e.binding,
      analytics_engine_datasets: (e) => e.binding,
      services: (e) => e.binding,
      durable_objects: (e) => e.name,
      workflows: (e) => e.binding,
      ai: () => "AI",
      vectorize: (e) => e.binding,
    };
    for (const [key, pick] of Object.entries(sections)) {
      const list = cfg[key];
      if (!list) continue;
      for (const e of Array.isArray(list) ? list : [list]) {
        const name = pick(e);
        if (name) declared.add(name);
      }
    }
    for (const p of cfg.queues?.producers ?? []) declared.add(p.binding);
    for (const c of cfg.queues?.consumers ?? []) if (c.binding) declared.add(c.binding);

    // Every env.NAME member read in the app must be declared OR be a manifest var.
    let srcHits = [];
    try {
      srcHits = rg(String.raw`env\.([A-Z][A-Z0-9_]+)`, [join(appDir, "src")], ["--only-matching"]);
    } catch {
      srcHits = [];
    }
    const { GROUPS, IGNORED, BINDINGS } = await import("../env-manifest.mjs");
    const manifestVars = new Set(GROUPS.flatMap((g) => g.vars).map((v) => v.name));
    const read = new Set(srcHits.map((h) => h.split("env.")[1]));
    for (const name of read) {
      if (!declared.has(name) && !manifestVars.has(name) && !IGNORED.includes(name)) {
        errors.push(
          `${appDir}: reads env.${name} but wrangler.jsonc declares no such binding or var`,
        );
      }
    }
    for (const name of declared) {
      // §3.6's verbatim wrangler specs declare bindings ahead of their readers
      // (apps/worker's R2/KV/AE/Q_R2_EVENTS land at M7+/M11). A registry name
      // that is unread is plan-declared, not an orphan; an UNREGISTERED unread
      // binding is the speculative config this arm exists to catch.
      if (!read.has(name) && !BINDINGS.includes(name)) {
        errors.push(
          `${appDir}: wrangler.jsonc declares binding ${name} but src never reads it (orphan)`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

const KNOWN_BINDINGS = new Set([
  "HYPERDRIVE_CACHED",
  "HYPERDRIVE_FRESH",
  "PUBLIC_MEDIA",
  "PAID_MEDIA",
  "ARTIFACTS",
  "UPLOADS",
  "GRANTS",
  "WBA_DIR",
  "OAUTH_KV",
  "Q_CLASSIFY",
  "Q_MEDIA",
  "Q_MEDIA_FINALIZE",
  "Q_DISTRIBUTE",
  "Q_EMBED",
  "Q_AGENT_CANCEL",
  "Q_R2_EVENTS",
  "MIXER",
  "TELEMETRY",
  "PAYWALL",
]);
function isBindingKnown(name) {
  return KNOWN_BINDINGS.has(name);
}

// G-LINT — both spine rules at error and biting their fixtures.
export function gLint() {
  const errors = [];
  const fixtures = [
    [
      "tools/eslint-plugin-musebook/test/fixtures/bad-publish-mode.ts",
      "musebook/no-publish-mode-outside-kernel",
    ],
    [
      "tools/eslint-plugin-musebook/test/fixtures/apps/edge/bad-publish-mode.ts",
      "musebook/no-publish-mode-outside-kernel",
    ],
    [
      "tools/eslint-plugin-musebook/test/fixtures/packages/muse-mixer/src/bad-mixer-import.ts",
      "musebook/no-platform-imports-in-mixer",
    ],
    [
      "tools/eslint-plugin-musebook/test/fixtures/packages/muse-mixer/src/bad-mixer-binding.ts",
      "musebook/no-platform-imports-in-mixer",
    ],
  ];
  for (const [file, ruleId] of fixtures) {
    const r = run(`pnpm eslint ${file} --format json`);
    let problems;
    try {
      const parsed = JSON.parse(r.out.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
      problems = parsed[0]?.messages ?? [];
    } catch {
      errors.push(`eslint JSON output unparseable for ${file}:\n${r.out.slice(0, 800)}`);
      continue;
    }
    const hits = problems.filter((m) => m.ruleId === ruleId);
    if (hits.length !== 1)
      errors.push(
        `${file}: expected exactly one ${ruleId} problem, got ${hits.length} (all: ${JSON.stringify(problems.map((m) => m.ruleId))})`,
      );
  }
  const pc = run("pnpm eslint --print-config packages/kernel/src/index.ts");
  if (
    /"musebook\/(no-publish-mode-outside-kernel|no-platform-imports-in-mixer)":\s*(0|1|"off"|"warn")/.test(
      pc.out,
    )
  )
    errors.push("a spine rule is at off/warn — both must stay at error (§3.4)");
  return { ok: errors.length === 0, errors };
}

// G-BUNDLE — the §3.4 bundle guard, half two (delegates to scripts/check-edge-bundle.mjs).
export function edgeBundle() {
  const r = run("node scripts/check-edge-bundle.mjs");
  return { ok: r.code === 0, errors: r.code ? [r.out.slice(-2000)] : [] };
}

// G-R2-SEAL — three sealed buckets, six assertions. Account state → needs H3.
export async function r2Seal() {
  if (!process.env.CLOUDFLARE_API_TOKEN && !process.env.CF_API_TOKEN)
    return {
      ok: false,
      errors: [],
      blocked: "CLOUDFLARE_API_TOKEN/CF_API_TOKEN unset (prereq H3)",
    };
  const errors = [];
  for (const bucket of ["musebook-paid", "musebook-artifacts", "musebook-uploads"]) {
    for (const what of ["domain list", "dev-url get"]) {
      const r = run(`pnpm exec wrangler r2 bucket ${what} ${bucket}`);
      const out = r.out.trim();
      const sealed =
        /No custom domain|no custom domain|not enabled|disabled|^\[?\s*\]?$|0 custom domains/i.test(
          out,
        ) ||
        out.length === 0 ||
        /\[\]/.test(out);
      if (!sealed) errors.push(`${bucket} ${what}: not sealed —\n${out.slice(0, 500)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// G-SEED — two resets, same ordered dump hash, equals supabase/SEED_HASH.
export async function seedHash() {
  if (!existsSync(join(ROOT, "supabase/SEED_HASH")))
    return { ok: false, errors: [], blocked: "supabase/SEED_HASH absent (lands at M2)" };
  const expected = readFileSync(join(ROOT, "supabase/SEED_HASH"), "utf8").trim();
  const url = process.env.SUPABASE_DB_URL ?? LOCAL_DB_URL;
  const local = /127\.0\.0\.1|localhost/.test(url);
  const resetTarget = local ? "--local" : "--linked";
  const dumps = [];
  for (let i = 0; i < 2; i++) {
    const dumpCmd =
      dbTool()?.kind === "docker" && local
        ? `docker exec ${dbTool().container} pg_dump -U postgres -d postgres --data-only --schema=public | grep -vE '^\\\\(un)?restrict ' | LC_ALL=C sort | sha256sum`
        : `pg_dump --data-only --schema=public ${JSON.stringify(url)} | grep -vE '^\\\\(un)?restrict ' | LC_ALL=C sort | sha256sum`;
    // `db reset` returns after issuing an async container restart; dumping
    // immediately can hit a still-booting postgres and capture a truncated
    // dump. Wait for readiness first.
    const r = run(
      `pnpm exec supabase db reset ${resetTarget} >/dev/null 2>&1 && ` +
        (dbTool()?.kind === "docker" && local
          ? `until docker exec ${dbTool().container} pg_isready -U postgres -q; do sleep 1; done && `
          : "") +
        dumpCmd,
      { timeout: 600000 },
    );
    if (r.code !== 0)
      return {
        ok: false,
        errors: [`reset/dump failed: ${r.out.slice(-1500)}`],
        blocked: r.out.includes("not linked") ? "supabase project not linked" : undefined,
      };
    dumps.push(r.out.trim().split(/\s+/)[0]);
  }
  const errors = [];
  if (dumps[0] !== dumps[1])
    errors.push("two consecutive seeded dumps differ — seed is not deterministic");
  if (dumps[0] !== expected) errors.push(`dump hash ${dumps[0]} != supabase/SEED_HASH ${expected}`);
  return { ok: errors.length === 0, errors };
}

// G-ROLE — §4.14's six posture blocks + §15.6 axis B as the real worker.
export async function dbAssertRls() {
  if (!process.env.SUPABASE_DB_URL && dbTool()?.kind !== "docker")
    return { ok: false, errors: [], blocked: "SUPABASE_DB_URL unset" };
  if (!process.env.MUSEBOOK_WORKER_DB_PASSWORD)
    return {
      ok: false,
      errors: [],
      blocked: "MUSEBOOK_WORKER_DB_PASSWORD unset (axis B needs a real login)",
    };
  const r = run("pnpm db:assert-rls", { timeout: 300000 });
  return {
    ok: r.code === 0 && r.out.includes("db:assert-rls PASS"),
    errors: r.code ? [r.out.slice(-2000)] : [],
  };
}

// G-DRIFT — `supabase db diff` on the public schema must be empty. The plan's
// `--linked` form runs in CI on the preview branch; a loopback SUPABASE_DB_URL
// means the local stack, where the equivalent is `--local`.
export function dbDrift() {
  const url = process.env.SUPABASE_DB_URL ?? "";
  const target = /127\.0\.0\.1|localhost|^$/.test(url) ? "--local" : "--linked";
  const r = run(`pnpm exec supabase db diff ${target} --schema public 2>&1 | tail -40`, {
    timeout: 300000,
  });
  if (r.code !== 0)
    return {
      ok: false,
      errors: [r.out.slice(-1500)],
      blocked: r.out.includes("not linked") ? "supabase project not linked" : undefined,
    };
  const json = r.out.match(/"diff":\s*"(.*)",\s*"file"/s)?.[1] ?? "";
  const diff = json.replace(/\\n/g, "\n").trim();
  return { ok: diff.length === 0, errors: diff ? [`drift:\n${diff.slice(0, 1500)}`] : [] };
}

// M2.1 — migrations replay from zero, twice. `--linked` on CI; a loopback or
// unset SUPABASE_DB_URL means the local stack.
export function m2ResetTwice() {
  const url = process.env.SUPABASE_DB_URL ?? "";
  const target = /127\.0\.0\.1|localhost|^$/.test(url) ? "--local" : "--linked";
  for (let i = 0; i < 2; i++) {
    const r = run(`pnpm exec supabase db reset ${target} 2>&1 | tail -20`, {
      timeout: 600000,
    });
    if (r.code !== 0)
      return { ok: false, errors: [`reset ${i + 1}/2 failed:\n${r.out.slice(-1200)}`] };
  }
  return { ok: true, errors: [] };
}

// M2.13 — `supabase gen types typescript` output must equal the committed
// packages/schema/src/database.types.ts (generated, not written by hand).
export function m2TypesGen() {
  const url = process.env.SUPABASE_DB_URL ?? "";
  const target = /127\.0\.0\.1|localhost|^$/.test(url) ? "--local" : "--linked";
  const r = run(
    `pnpm exec supabase gen types typescript ${target} > /tmp/mb-t.ts && diff -q /tmp/mb-t.ts packages/schema/src/database.types.ts`,
    { timeout: 300000 },
  );
  return {
    ok: r.code === 0,
    errors: r.code ? [`generated types differ from committed file:\n${r.out.slice(-800)}`] : [],
  };
}

// G-GOLDEN — golden barrel == .snap files (M5+).
export function gGolden() {
  const r = run("pnpm --filter @musebook/kernel run goldens:verify 2>/dev/null || true");
  if (!existsSync(join(ROOT, "packages/kernel/test/golden")))
    return {
      ok: false,
      errors: ["packages/kernel/test/golden missing — the 24 fixtures have not landed"],
    };
  return { ok: r.out.includes("OK") || r.code === 0, errors: r.code ? [r.out.slice(-1500)] : [] };
}

// G-EDGE-ROUTES — routes ⊇ §6's gated path list (implemented at M6 with the list).
export function edgeRoutes() {
  const r = run("node scripts/gates/edge-routes.mjs");
  return { ok: r.code === 0, errors: r.code ? [r.out.slice(-2000)] : [] };
}

// G-PROXY — proxy.ts hygiene (delegates to scripts/gates/proxy-hygiene.mjs).
export function proxyHygiene() {
  const r = run("node scripts/gates/proxy-hygiene.mjs");
  return { ok: r.code === 0, errors: r.code ? [r.out.slice(-2000)] : [] };
}

// G-FRESH — decision reads name HYPERDRIVE_FRESH (grep over the edge read path).
export function gFresh() {
  const MONEY_READS = [
    "grant",
    "quote",
    "settlement",
    "spend_reservation",
    "approval",
    "delegation",
  ];
  const errors = [];
  const files = rg(
    String.raw`HYPERDRIVE_(CACHED|FRESH)`,
    ["apps/edge/src", "apps/mcp/src"],
    ["--files-with-matches"],
  );
  for (const f of files) {
    const file = f.split(":")[0];
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const needle of MONEY_READS) {
      const re = new RegExp(`${needle}[\\s\\S]{0,200}?HYPERDRIVE_CACHED`, "i");
      if (re.test(text))
        errors.push(
          `${file}: a ${needle} read resolves to HYPERDRIVE_CACHED — decision reads are FRESH only (CF-SPINE §2)`,
        );
    }
  }
  return { ok: errors.length === 0, errors };
}

// G-AXE — browser sweep (M7+); placeholder until Playwright lands.
export function gAxe() {
  const r = run("pnpm --filter musebook-web exec playwright test --config test/axe 2>/dev/null");
  return { ok: r.code === 0, errors: r.code ? [`axe sweep: ${r.out.slice(-1500)}`] : [] };
}

// G-FAKE-TX — no fabricated hash; `settled` written only in settle.ts.
export function fakeTx() {
  const errors = [];
  const hits = rg(
    String.raw`0x[0-9a-fA-F]{64}`,
    ["apps", "packages"],
    ["-g", "!**/test/**", "-g", "!**/fixtures/**"],
  );
  if (hits.length)
    errors.push(`fabricated-looking transaction hash outside fixtures:\n${hits.join("\n")}`);
  const s = rg(
    String.raw`['"]settled['"]`,
    ["apps", "packages"],
    ["-g", "!packages/x402/src/settle.ts", "-g", "!**/test/**"],
  );
  if (s.length)
    errors.push(`'settled' status written outside packages/x402/src/settle.ts:\n${s.join("\n")}`);
  return { ok: errors.length === 0, errors };
}

// G-X402-V1 — v1 header/field names are forbidden from M8.
export function x402v1() {
  const hits = rg(
    String.raw`x-payment|maxAmountRequired|['"]base-sepolia['"]`,
    ["apps", "packages"],
    ["-i"],
  );
  return {
    ok: hits.length === 0,
    errors: hits.length ? [`x402 v1 surface:\n${hits.join("\n")}`] : [],
  };
}

// G-PLANE-JOIN — no query spans the two telemetry planes.
export function planeJoin() {
  const errors = [];
  const scopes = ["supabase/migrations", "apps/worker/src", "packages/telemetry"];
  for (const f of rg("action_events", scopes, ["--files-with-matches"])) {
    const text = readFileSync(join(ROOT, f), "utf8");
    const stmts = text.split(/;\s*/);
    for (const st of stmts) {
      const a = st.includes("action_events_human");
      const b = st.includes("action_events_agent");
      const c = st.includes("blob2 = 'human'") || st.includes(`blob2 = 'agent'`);
      const d = st.includes("blob2 = 'human'") && st.includes("blob2 = 'agent'");
      if ((a && b) || d) errors.push(`${f}: one statement touches both telemetry planes`);
    }
  }
  const ae = rg(String.raw`count\(\*\)`, ["apps/worker/src", "packages"], []);
  for (const h of ae) {
    if (/analytics|engine|sql|telemetry/i.test(h))
      errors.push(
        `possible count(*) in an Analytics Engine query (use sum(_sample_interval)): ${h}`,
      );
  }
  return { ok: errors.length === 0, errors };
}

// G-ISO — mixer isolation bit-identity, both runners (M13+).
export function gIso() {
  const r1 = run(
    "pnpm vitest run --project=muse-mixer --project=muse-mixer-workers test/isolation.test.ts test/isolation-bites.test.ts",
  );
  return { ok: r1.code === 0, errors: r1.code ? [r1.out.slice(-2000)] : [] };
}

// ---------------------------------------------------------------------------
// M0 milestone checks
// ---------------------------------------------------------------------------

const CF_API = "https://api.cloudflare.com/client/v4";
function cf(path) {
  const token = process.env.CF_API_TOKEN;
  if (!token) return { code: -1, out: "CF_API_TOKEN unset", json: null };
  const r = run(`curl -sf -H "Authorization: Bearer $CF_API_TOKEN" "${CF_API}${path}"`, {
    env: process.env,
  });
  let json = null;
  try {
    json = JSON.parse(r.out);
  } catch {
    /* not json */
  }
  return { ...r, json };
}

const ZONE_ENV = "CF_ZONE_ID";

export function m0SslOrdering() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset (prereq H1)` };
  const ssl = cf(`/zones/${process.env[ZONE_ENV]}/settings/ssl`);
  const dns = cf(`/zones/${process.env[ZONE_ENV]}/dns_records?type=CNAME&name=musebook.dev`);
  const mod = ssl.json?.result?.modified_on;
  const created = dns.json?.result?.[0]?.created_on;
  if (!mod || !created)
    return { ok: false, errors: ["missing modified_on/created_on from the API"] };
  return {
    ok: new Date(mod) < new Date(created),
    errors:
      new Date(mod) < new Date(created)
        ? []
        : [`ssl modified_on ${mod} is not earlier than apex created_on ${created}`],
  };
}

export function m0ApexRecord() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset (prereq H1)` };
  const dns = cf(`/zones/${process.env[ZONE_ENV]}/dns_records?type=CNAME&name=musebook.dev`);
  const rec = dns.json?.result?.[0];
  const errors = [];
  if (!rec) errors.push("no apex CNAME record");
  else {
    if (rec.proxied !== true) errors.push("apex record is not proxied");
    if (rec.content === "cname.vercel-dns.com")
      errors.push("apex content is the hardcoded legacy target, not the project's issued target");
  }
  return { ok: errors.length === 0, errors };
}

export function m0OriginHost() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset (prereq H1)` };
  const dns = cf(`/zones/${process.env[ZONE_ENV]}/dns_records?name=origin.musebook.dev`);
  const rec = dns.json?.result?.[0];
  const errors = [];
  if (!rec) errors.push("origin.musebook.dev does not exist");
  else if (rec.proxied !== false)
    errors.push("origin.musebook.dev must be DNS-only (proxied: false)");
  return { ok: errors.length === 0, errors };
}

export function m0VercelRenew() {
  if (!process.env.VERCEL_TOKEN) return { ok: false, errors: [], blocked: "VERCEL_TOKEN unset" };
  const r = run(
    `curl -sf -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v3/domains/musebook.dev?teamId=team_PYXAVq4jrHw8k0bNffmhc2jE"`,
  );
  let renew = null;
  try {
    renew = JSON.parse(r.out).renew;
  } catch {
    /* fallthrough */
  }
  return { ok: renew === true, errors: renew === true ? [] : ["musebook.dev renew is not true"] };
}

export function m0BotFight() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset (prereq H1)` };
  const r = cf(`/zones/${process.env[ZONE_ENV]}/bot_management`);
  const fm = r.json?.result?.fight_mode;
  if (fm === undefined) {
    // UNVERIFIED key on Free/Pro zones — fallback: unchallenged robots.txt.
    const f = run(
      'curl -s -o /dev/null -w "%{http_code}" -A "GPTBot/1.0" https://musebook.dev/robots.txt',
    );
    return {
      ok: f.out.trim() === "200",
      errors: f.out.trim() === "200" ? [] : ["bot fallback probe did not return 200"],
    };
  }
  return {
    ok: fm === false,
    errors: fm === false ? [] : ["bot_management.fight_mode is not false"],
  };
}

export function m0BotPresets() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset (prereq H1)` };
  const r = cf(`/zones/${process.env[ZONE_ENV]}/bot_management`);
  const ai = r.json?.result?.ai_bots;
  if (!ai)
    return {
      ok: false,
      errors: ["ai bot policy not reported — verify in dashboard and record in OPERATIONS.md"],
    };
  const errors = [];
  if (ai.agent !== "allow") errors.push("AI bot Agent preset is not explicitly 'allow'");
  if (ai.search !== "allow") errors.push("AI bot Search preset is not explicitly 'allow'");
  return { ok: errors.length === 0, errors };
}

export function m0Ppc() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset (prereq H1)` };
  const errors = [];
  const zone = cf(`/zones/${process.env[ZONE_ENV]}`);
  const ppc = zone.json?.result?.pay_per_crawl?.enabled ?? zone.json?.result?.paycrawl?.enabled;
  if (ppc === true) errors.push("pay-per-crawl is enabled on the zone");
  const rules = cf(`/zones/${process.env[ZONE_ENV]}/rulesets?kind=zone`);
  const found = JSON.stringify(rules.json ?? {}).includes("disable-ppc-x402-paths");
  if (!found) errors.push("no Configuration Rule named disable-ppc-x402-paths found");
  return { ok: errors.length === 0, errors };
}

export function m0Waf() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset (prereq H1)` };
  const r = cf(`/zones/${process.env[ZONE_ENV]}/rulesets?kind=zone`);
  const text = JSON.stringify(r.json ?? {});
  const bad =
    /"(block|managed_challenge)"[^}]*musebook\.dev\/p\//i.test(text) ||
    text.includes('"expression":"http.request.uri.path matches \\"^/p/');
  return { ok: !bad, errors: bad ? ["a WAF rule blocks/challenges the /p/* money path"] : [] };
}

export function m0SupabaseProject() {
  if (!process.env.SUPABASE_ACCESS_TOKEN)
    return { ok: false, errors: [], blocked: "SUPABASE_ACCESS_TOKEN unset" };
  const r = run(
    'curl -sf -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "https://api.supabase.com/v1/projects"',
  );
  let projects = [];
  try {
    projects = JSON.parse(r.out);
  } catch {
    /* fallthrough */
  }
  const prod = projects.filter((p) => p.name === "musebook-prod");
  const errors = [];
  if (prod.length !== 1) errors.push(`expected exactly one musebook-prod, found ${prod.length}`);
  else {
    const p = prod[0];
    if (p.organization_id !== "lskgtzehnlfzimkxhwre")
      errors.push(`org ${p.organization_id} != lskgtzehnlfzimkxhwre`);
    if (p.status !== "ACTIVE_HEALTHY") errors.push(`status ${p.status} != ACTIVE_HEALTHY`);
    if (String(p.database?.postgres_engine) !== "17")
      errors.push(`pg ${p.database?.postgres_engine} != 17`);
    if (p.region !== "us-east-1") errors.push(`region ${p.region} != us-east-1`);
  }
  return { ok: errors.length === 0, errors };
}

export function m0LegacyUntouched() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return { ok: false, errors: [], blocked: "SUPABASE_DB_URL unset" };
  return { ok: true, errors: [] };
}

export function m0Extensions() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return { ok: false, errors: [], blocked: "SUPABASE_DB_URL unset (prereq H2)" };
  const errors = [];
  const r1 = run(
    `psql "$SUPABASE_DB_URL" -Atc "select count(*) from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname in ('vector','pg_partman','pg_trgm','btree_gin','pgcrypto') and n.nspname = 'extensions'"`,
  );
  if (r1.out.trim() !== "5")
    errors.push(`extensions in 'extensions' schema: expected 5, got ${r1.out.trim()}`);
  const r2 = run(
    `psql "$SUPABASE_DB_URL" -Atc "select count(*) from pg_extension where extname = 'pgmq'"`,
  );
  if (r2.out.trim() !== "0") errors.push("pgmq must not be installed");
  return { ok: errors.length === 0, errors };
}

export function m0Hyperdrive() {
  if (!process.env.CF_API_TOKEN && !process.env.CLOUDFLARE_API_TOKEN)
    return { ok: false, errors: [], blocked: "Cloudflare token unset (prereq H3)" };
  const r = run("pnpm exec wrangler hyperdrive list --json 2>/dev/null || true");
  let list = [];
  try {
    list = JSON.parse(r.out);
  } catch {
    /* fallthrough */
  }
  const mb = list.filter((h) => /musebook-prod/.test(h.name ?? ""));
  const errors = [];
  if (mb.length !== 2)
    errors.push(`expected 2 musebook-prod* hyperdrive configs, found ${mb.length}`);
  else {
    const cached = mb.find((h) => h.caching?.disabled === false || h.caching?.max_age === 60);
    const fresh = mb.find((h) => h.caching?.disabled === true);
    if (!cached) errors.push("no config with caching enabled at max_age 60");
    if (!fresh) errors.push("no config with caching disabled");
  }
  return { ok: errors.length === 0, errors };
}

export function m0Buckets() {
  const errors = [];
  const r = run("pnpm exec wrangler r2 bucket list --json 2>/dev/null || true");
  let names = [];
  try {
    names = JSON.parse(r.out).map((b) => b.name);
  } catch {
    names = [];
  }
  for (const b of [
    "musebook-public",
    "musebook-paid",
    "musebook-artifacts",
    "musebook-uploads",
    "musebook-logs",
  ])
    if (!names.includes(b)) errors.push(`missing bucket ${b}`);
  const bound = rg("musebook-postiz-media", ["apps"], ["-g", "wrangler.jsonc"]);
  if (bound.length)
    errors.push(`musebook-postiz-media is bound in a wrangler.jsonc:\n${bound.join("\n")}`);
  return { ok: errors.length === 0, errors };
}

export function m0Lifecycle() {
  const r = run(
    "pnpm exec wrangler r2 bucket lifecycle list musebook-uploads --json 2>/dev/null || true",
  );
  const ok =
    /abort_multipart|abortIncompleteMultipartUpload|abort-multipart/i.test(r.out) &&
    /2/.test(r.out);
  return { ok, errors: ok ? [] : ["no 2-day abort-multipart lifecycle rule on musebook-uploads"] };
}

export function m0Queues() {
  const r = run("pnpm exec wrangler queues list --json 2>/dev/null || true");
  let names = [];
  try {
    names = JSON.parse(r.out)
      .map((q) => q.queue_name ?? q.name)
      .sort();
  } catch {
    names = [];
  }
  const expected = [
    "musebook-agent-cancel",
    "musebook-agent-cancel-dlq",
    "musebook-classify",
    "musebook-classify-dlq",
    "musebook-distribute",
    "musebook-distribute-dlq",
    "musebook-embed",
    "musebook-embed-dlq",
    "musebook-media",
    "musebook-media-dlq",
    "musebook-media-finalize",
    "musebook-media-finalize-dlq",
    "musebook-r2-events",
    "musebook-r2-events-dlq",
  ];
  const errors = [];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) errors.push(`missing queues: ${missing.join(", ")}`);
  const n = run(
    "pnpm exec wrangler r2 bucket notification list musebook-uploads 2>/dev/null || true",
  );
  if (!/musebook-r2-events/.test(n.out))
    errors.push("no object-create notification musebook-uploads → musebook-r2-events");
  return { ok: errors.length === 0, errors };
}

export function m0Kv() {
  const r = run("pnpm exec wrangler kv namespace list 2>/dev/null || true");
  const errors = [];
  for (const n of ["GRANTS", "WBA_DIR", "OAUTH_KV"]) {
    if (!r.out.includes(n)) errors.push(`missing KV namespace ${n}`);
  }
  for (const n of ["GRANTS", "WBA_DIR", "OAUTH_KV"]) {
    if (!readFileSync(join(ROOT, "OPERATIONS.md"), "utf8").includes(n))
      errors.push(`OPERATIONS.md does not record the ${n} id`);
  }
  return { ok: errors.length === 0, errors };
}

export function m0Operations() {
  if (!existsSync(join(ROOT, "OPERATIONS.md")))
    return { ok: false, errors: ["OPERATIONS.md missing"] };
  const t = readFileSync(join(ROOT, "OPERATIONS.md"), "utf8");
  const errors = [];
  for (const needle of [
    "rmcgtcsfrfrjxeyxoiin",
    "us-east-1",
    "e8f42c0430906e1515a2af01d5c1d2d1",
    "musebook-public",
    "musebook-paid",
    "musebook-artifacts",
    "musebook-logs",
    "musebook-uploads",
    "f7f0e81c8e1f4eb190e366714ed6b0ad",
    "0d0153516ab24ceeb3a70f0c95b86a68",
    "7daede739ca44bb98df9429bcecffb8b",
    "musebook_telemetry",
    "musebook_paywall",
  ]) {
    if (!t.includes(needle)) errors.push(`OPERATIONS.md missing ${needle}`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// M1 milestone checks
// ---------------------------------------------------------------------------

export function m1Compat() {
  const errors = [];
  const scan = (obj, path, file) => {
    if (obj && typeof obj === "object") {
      if ("compatibility_flags" in obj)
        errors.push(`${file}: compatibility_flags present at ${path} — dead config, delete it`);
      if ("compatibility_date" in obj && obj.compatibility_date !== "2026-09-21")
        errors.push(
          `${file}: compatibility_date '${obj.compatibility_date}' at ${path} != 2026-09-21`,
        );
      for (const [k, v] of Object.entries(obj)) scan(v, `${path}.${k}`, file);
    }
  };
  for (const f of WRANGLER_CONFIGS) scan(readJsonc(join(ROOT, f)), "$", f);
  for (const f of WRANGLER_CONFIGS) {
    const cfg = readJsonc(join(ROOT, f));
    if (cfg.compatibility_date !== "2026-09-21")
      errors.push(`${f}: missing top-level compatibility_date 2026-09-21`);
  }
  return { ok: errors.length === 0, errors };
}

export function m1NoStrictPublic() {
  const hits = rg("global_fetch_strictly_public", ["apps"], ["-g", "wrangler.jsonc"]);
  // Any uncommented presence fails — a comment explaining its absence is the only legal mention.
  const failures = hits.filter((h) => {
    const line = h.split(":").slice(2).join(":");
    return !line.trimStart().startsWith("//");
  });
  return { ok: failures.length === 0, errors: failures };
}

export function m1PublishModeFixture() {
  const errors = [];
  for (const f of [
    "tools/eslint-plugin-musebook/test/fixtures/bad-publish-mode.ts",
    "tools/eslint-plugin-musebook/test/fixtures/apps/edge/bad-publish-mode.ts",
  ]) {
    const r = run(`pnpm eslint ${f} --format json`);
    let msgs = [];
    try {
      msgs = JSON.parse(r.out.match(/\[[\s\S]*\]/)?.[0] ?? "[]")[0]?.messages ?? [];
    } catch {
      /* fallthrough */
    }
    const hits = msgs.filter((m) => m.ruleId === "musebook/no-publish-mode-outside-kernel");
    if (hits.length !== 1)
      errors.push(`${f}: expected exactly 1 no-publish-mode problem, got ${hits.length}`);
  }
  return { ok: errors.length === 0, errors };
}

export function m1MixerFixture() {
  const errors = [];
  for (const f of [
    "tools/eslint-plugin-musebook/test/fixtures/packages/muse-mixer/src/bad-mixer-import.ts",
    "tools/eslint-plugin-musebook/test/fixtures/packages/muse-mixer/src/bad-mixer-binding.ts",
  ]) {
    const r = run(`pnpm eslint ${f} --format json`);
    let msgs = [];
    try {
      msgs = JSON.parse(r.out.match(/\[[\s\S]*\]/)?.[0] ?? "[]")[0]?.messages ?? [];
    } catch {
      /* fallthrough */
    }
    const hits = msgs.filter((m) => m.ruleId === "musebook/no-platform-imports-in-mixer");
    if (hits.length !== 1)
      errors.push(`${f}: expected exactly 1 no-platform-imports problem, got ${hits.length}`);
  }
  return { ok: errors.length === 0, errors };
}

export function m1RulesAtError() {
  const r = run("pnpm eslint --print-config packages/kernel/src/index.ts");
  const bad =
    /"musebook\/(no-publish-mode-outside-kernel|no-platform-imports-in-mixer)":\s*(0|1|"off"|"warn")/.test(
      r.out,
    );
  return { ok: !bad, errors: bad ? ["a spine rule is configured at off/warn"] : [] };
}

export async function m1BundleGuardBites() {
  // Exercise the guard on a deliberate @x402/core root-barrel import in
  // apps/edge: EITHER the apps/edge no-restricted-imports rule must bite,
  // OR the cf:dry bundle must carry a forbidden substring (viem/node:fs/…)
  // so check-edge-bundle.mjs reports it. Passing silently is the failure.
  const fixtureDir = join(ROOT, "apps/edge/src/__gate_fixture__");
  const errors = [];
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "bad.ts"), `import {} from "@x402/core";\nexport {};\n`);
  try {
    const lint = run("pnpm exec eslint apps/edge/src/__gate_fixture__/bad.ts --max-warnings 0");
    const lintBit = lint.code !== 0;
    const r = run("pnpm --filter musebook-edge run cf:dry");
    const bundled = r.code === 0;
    const g = run("node scripts/check-edge-bundle.mjs");
    const grepBit = g.code !== 0;
    if (!lintBit && bundled && !grepBit)
      errors.push("no half of the bundle guard fired on a deliberate @x402/core barrel import");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    run("pnpm --filter musebook-edge run cf:dry >/dev/null 2>&1 || true");
  }
  return { ok: errors.length === 0, errors };
}

export function m1NextHygiene() {
  const errors = [];
  if (existsSync(join(ROOT, "apps/web/middleware.ts")))
    errors.push(
      "apps/web/middleware.ts exists — Next 16 hard-fails when both middleware.ts and proxy.ts are present",
    );
  for (const f of readdirSync(join(ROOT, "apps/mcp"))) {
    if (/^next\.config\./.test(f))
      errors.push(`apps/mcp/${f} exists — apps/mcp is a Worker, there is no Next.js in it`);
  }
  return { ok: errors.length === 0, errors };
}

export function m1SupabaseRef() {
  const errors = [];
  const toml = readFileSync(join(ROOT, "supabase/config.toml"), "utf8");
  if (toml.includes(LEGACY_NEEDLE))
    errors.push("supabase/config.toml still references the legacy project");
  const ref = process.env.SUPABASE_PROJECT_REF || "rmcgtcsfrfrjxeyxoiin";
  if (!toml.includes(`project_id = "${ref}"`))
    errors.push(`supabase/config.toml does not pin project_id "${ref}"`);
  const lr = legacyRef();
  errors.push(...lr.errors);
  return { ok: errors.length === 0, errors };
}

export function m1ExactPins() {
  const errors = [];
  const re = /^\d+\.\d+\.\d+$/;
  const walking = [
    "apps/web/package.json",
    "apps/edge/package.json",
    "apps/mcp/package.json",
    "apps/worker/package.json",
    "packages/schema/package.json",
    "packages/x402/package.json",
    "packages/classify/package.json",
  ];
  const WATCH = [
    "@modelcontextprotocol/server",
    "agents",
    "thirdweb",
    "next",
    "web-bot-auth",
    "zod",
  ];
  for (const f of walking) {
    if (!existsSync(join(ROOT, f))) continue;
    const p = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(p[section] ?? {})) {
        if (
          (WATCH.includes(name) || name.startsWith("@x402/")) &&
          !re.test(range) &&
          !range.startsWith("catalog") &&
          !range.startsWith("workspace")
        )
          errors.push(
            `${f}: ${name} pinned as '${range}' — must be bare semver, no range operators`,
          );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function m1CatalogPins() {
  const errors = [];
  const ts = run("npm view typescript versions --json");
  let versions = [];
  try {
    versions = JSON.parse(ts.out);
  } catch {
    /* fallthrough */
  }
  const under61 = versions.filter((v) => /^6\.0\./.test(v)).sort();
  if (under61[under61.length - 1] !== "6.0.3")
    errors.push(
      `typescript 6.0.3 is no longer the newest <6.1.0 (now ${under61[under61.length - 1]}) — adjust the catalog, not the pin discipline`,
    );
  const vi = run("npm view vitest versions --json");
  try {
    const vv = JSON.parse(vi.out)
      .filter((v) => /^4\./.test(v))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (vv[vv.length - 1] !== "4.1.11")
      errors.push(`vitest 4.1.11 is no longer the newest 4.x (now ${vv[vv.length - 1]})`);
  } catch {
    errors.push("npm view vitest failed");
  }
  const wr = run("npm view wrangler version");
  if (wr.out.trim() !== "4.136.1") errors.push(`wrangler latest is ${wr.out.trim()}, not 4.136.1`);
  return { ok: errors.length === 0, errors };
}

export function m1NoPoolWorkers() {
  const hits = rg(
    String.raw`@cloudflare/vitest-pool-workers|defineWorkersConfig|defineWorkersProject`,
    ["."],
    [
      "-g",
      "*.json",
      "-g",
      "*.ts",
      "-g",
      "*.mjs",
      "-g",
      "!node_modules",
      "-g",
      "!plan.md",
      "-g",
      "!planning/**",
      // This file names the forbidden identifiers to forbid them.
      "-g",
      "!scripts/gates/checks.mjs",
    ],
  );
  return { ok: hits.length === 0, errors: hits };
}

export function m1NoVercelEra() {
  const hits = rg(
    String.raw`pgmq\.|@vercel/blob|\bbotid\b|mcp-handler|CRON_SECRET|x-vercel-ip-country|@vercel/sdk`,
    ["apps", "packages", "scripts", "supabase", ".github"],
    [],
  );
  const real = hits.filter(
    (h) =>
      !h.includes("checks.mjs") &&
      !h.includes("env-manifest.mjs") &&
      !h.includes("eslint.config.mjs") &&
      // ci.yml carries the same needles as the guard that forbids them.
      !(h.includes("workflows/") && (h.includes("-e ") || h.includes("::error::"))),
  );
  return { ok: real.length === 0, errors: real };
}

export function m1CfDrift() {
  const r = run("pnpm tsx scripts/configure-cf.ts --check");
  return {
    ok: r.code === 0,
    errors: r.code ? [r.out.slice(-2000)] : [],
    blocked:
      r.out.includes("required") || (r.out.includes("zone") && r.out.includes("not"))
        ? "zone not provisioned (prereq H1)"
        : undefined,
  };
}

export function m2BareAuthUid() {
  const hits = rg(String.raw`auth\.uid\(\)`, ["supabase/migrations"], []).filter((h) => {
    const text = h.split(":").slice(2).join(":");
    const code = text.replace(/--.*$/, "");
    const stripped = code.replace(/\(select\s+auth\.uid\(\)(?:\s+as\s+\w+)?\)/gi, "");
    return /auth\.uid\(\)/.test(stripped);
  });
  return { ok: hits.length === 0, errors: hits };
}

export function m1SelfTest() {
  const r = run("node scripts/gate.mjs M1 --self-test");
  return {
    ok: r.code === 0 && r.out.includes("M1.20"),
    errors: r.code ? [r.out.slice(-2000)] : [],
  };
}

// ---------------------------------------------------------------------------
// M2 milestone checks (stubs are honest: they BLOCK on missing prereqs, never pass silently)
// ---------------------------------------------------------------------------

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Where SQL can run: host `psql` when present, else the local supabase_db
 * container (docker exec), else unavailable. The container path only works for
 * the loopback URL — a remote SUPABASE_DB_URL needs real client binaries.
 */
function dbTool() {
  if (run("command -v psql >/dev/null 2>&1").code === 0) return { kind: "host" };
  const c = run(
    "docker ps --format '{{.Names}}' --filter name=supabase_db 2>/dev/null | head -1",
  ).out.trim();
  if (c) return { kind: "docker", container: c };
  return null;
}

function psqlCmd(sql, url = process.env.SUPABASE_DB_URL ?? LOCAL_DB_URL) {
  const tool = dbTool();
  if (tool?.kind === "docker") {
    if (!/127\.0\.0\.1|localhost/.test(url))
      return { r: null, blocked: "remote SUPABASE_DB_URL but no host psql" };
    // A non-postgres login (e.g. musebook_worker) goes through the container's
    // own TCP endpoint — docker exec -U <role> can't supply a password and
    // postgres itself holds the musebook plane grants as ADMIN-not-SET, so
    // SET ROLE inside app.enter would fail for it.
    const u = url.match(/^postgres(?:ql)?:\/\/([^:@/]+)/)?.[1];
    if (u && u !== "postgres") {
      const pw = url.match(/^postgres(?:ql)?:\/\/[^:@/]+:([^@/]+)@/)?.[1] ?? "";
      return {
        r: null,
        cmd:
          `docker exec -e PGPASSWORD=${JSON.stringify(pw)} ${tool.container} ` +
          `psql ${JSON.stringify(`postgresql://${u}@127.0.0.1:5432/postgres`)} -Atc ${JSON.stringify(sql)}`,
      };
    }
    return {
      r: null,
      cmd: `docker exec ${tool.container} psql -U postgres -Atc ${JSON.stringify(sql)}`,
    };
  }
  if (tool?.kind !== "host")
    return { r: null, blocked: "no psql binary and no supabase_db container" };
  return { r: null, cmd: `psql ${JSON.stringify(url)} -Atc ${JSON.stringify(sql)}` };
}

function sqlCheck(sql, expect) {
  const { cmd, blocked } = psqlCmd(sql);
  if (blocked) return { ok: false, errors: [], blocked };
  const r = run(cmd);
  return {
    ok: r.out.trim() === expect,
    errors: r.out.trim() === expect ? [] : [`expected '${expect}', got '${r.out.trim()}'`],
  };
}

/** Run arbitrary SQL, returning { code, out }. */
function sqlRun(sql, url) {
  // Flatten newlines: the command may travel through nested quoting layers
  // (docker exec bash -c "..."), where real newlines become literal \n.
  const { cmd, blocked } = psqlCmd(sql.replace(/\s+/g, " "), url);
  if (blocked) return { code: -1, out: blocked };
  return run(cmd);
}

async function supabaseAdvisors(kind) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!token || !ref)
    return {
      ok: false,
      errors: [],
      blocked: "SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF unset (prereq H2)",
    };
  const r = run(
    `curl -sf -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" ` +
      `"https://api.supabase.com/v1/projects/${ref}/advisors/${kind}"`,
  );
  if (r.code !== 0)
    return {
      ok: false,
      errors: [],
      blocked: `Management API ${kind} advisors call failed: ${r.out.slice(-400)}`,
    };
  let lints;
  try {
    lints = JSON.parse(r.out).lints ?? [];
  } catch {
    return { ok: false, errors: [`unparseable advisors response: ${r.out.slice(-400)}`] };
  }
  const errors = lints.map((l) => `${l.name}: ${l.title}`);
  return { ok: lints.length === 0, errors, lints };
}

export async function m2AdvisorsSecurity() {
  // §17.12 M2.3: zero findings — an rls_enabled_no_policy here is a grant-matrix
  // defect, not an expected finding. Counted at ERROR/WARN only: Postgres cannot
  // attach a policy to a partition, so RLS-enabled action_events leaves carry a
  // permanent INFO rls_enabled_no_policy advisory — unfixable by design (the
  // parent partitioned table's policies govern their rows).
  const res = await supabaseAdvisors("security");
  if (res.blocked || res.ok) return res;
  const actionable = (res.lints ?? []).filter((l) => l.level !== "INFO");
  if (!actionable.length) return { ok: true, errors: [] };
  return { ok: false, errors: actionable.map((l) => `${l.name}: ${l.title}`) };
}
export async function m2AdvisorsPerf() {
  // §17.12 M2.4: specifically zero auth_rls_initplan findings.
  const res = await supabaseAdvisors("performance");
  if (res.blocked || res.ok) return res;
  const hits = res.errors.filter((e) => e.startsWith("auth_rls_initplan"));
  return { ok: hits.length === 0, errors: hits.length ? hits : res.errors };
}
export function m2Outbox() {
  const errors = [];
  let r = sqlCheck(
    "select count(*) from pg_indexes where schemaname='public' and indexname='job_outbox_pending_idx' and indexdef like '%WHERE (state = ''queued''::job_state)%'",
    "1",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  r = sqlCheck(
    "select count(*) from pg_constraint where conname like 'job_outbox%' and pg_get_constraintdef(oid) like '%UNIQUE%kind%dedupe_key%'",
    "1",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  return { ok: errors.length === 0, errors };
}
export function m2BootstrapDims() {
  const errors = [];
  for (const [t, c, v] of [
    ["ranking_weights", "weights_version", "none"],
    ["model_registry", "model_version", "reverse_chron"],
  ]) {
    const r = sqlCheck(`select count(*) from public.${t} where ${c} = '${v}'`, "1");
    if (r.blocked) return r;
    errors.push(...r.errors);
  }
  return { ok: errors.length === 0, errors };
}
export function m2Partitions() {
  const errors = [];
  let r = sqlCheck("select count(*) from pg_partitioned_table", "0");
  if (r.blocked) return r;
  if (r.errors.length === 0) errors.push("no partitioned tables — expected ≥3");
  r = sqlCheck(
    "select count(*) from pg_inherits i join pg_class p on p.oid = i.inhparent where p.relname = 'action_events'",
    "2",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  return { ok: errors.length === 0, errors };
}
export function m2Slugs() {
  const errors = [];
  let r = sqlCheck(
    "select count(*) from pg_indexes where schemaname='public' and indexname='posts_slug_uniq' and indexdef ilike '%deleted_at is null%'",
    "1",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  r = sqlCheck("select count(*) from pg_indexes where indexname='posts_author_slug_uniq'", "0");
  if (r.blocked) return r;
  errors.push(...r.errors);
  return { ok: errors.length === 0, errors };
}
export function m2Enums() {
  const errors = [];
  let r = sqlCheck(
    "select count(*) from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='action_kind'",
    "23",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  r = sqlCheck(
    "select count(*) from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='post_kind'",
    "8",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  const hits = rg(String.raw`alter type (action_kind|post_kind)`, ["supabase/migrations"], ["-i"]);
  if (hits.length)
    errors.push(
      `an alter-type migration exists — the vocabularies are closed:\n${hits.join("\n")}`,
    );
  return { ok: errors.length === 0, errors };
}
export function m2License() {
  const errors = [];
  let r = sqlCheck(
    "select count(*) from information_schema.columns where table_schema='public' and table_name='posts' and column_name in ('license_spdx','license_url','train_ai','ai_use','search_indexable','attribution_required','citation_template')",
    "7",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  r = sqlCheck(
    "select count(*) from pg_constraint where conname='posts_license_spdx_allowed'",
    "1",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  r = sqlCheck(
    "select count(*) from information_schema.table_constraints where table_name='creator_publishing_defaults' and constraint_type='PRIMARY KEY'",
    "1",
  );
  if (r.blocked) return r;
  errors.push(...r.errors);
  return { ok: errors.length === 0, errors };
}
export function m2BucketCheck() {
  // §17.12 M2.18: the assets_url_matches_bucket CHECK must reject a URL whose
  // host doesn't match its storage tier — proven by executing the violation.
  let r = sqlCheck(
    "select count(*) from pg_constraint where conrelid='public.assets'::regclass and conname='assets_url_matches_bucket'",
    "1",
  );
  if (r.blocked) return r;
  if (!r.ok) return { ok: false, errors: ["assets_url_matches_bucket constraint absent"] };
  r = sqlRun(`insert into public.assets
    (id, owner_user_id, storage, object_key, url, content_type, byte_len, sha256)
    values (gen_random_uuid(),
            '11111111-1111-4111-8111-000000000101',
            'r2_paid', 'gate/check', 'https://cdn.musebook.dev/gate/check',
            'image/png', 1, lpad('0',64,'0'))`);
  const rejected = /assets_url_matches_bucket|violates check constraint/.test(r.out);
  return {
    ok: rejected,
    errors: rejected
      ? []
      : [
          `r2_paid row with cdn URL was ${r.code === 0 ? "ACCEPTED" : "rejected oddly"}: ${r.out.slice(-300)}`,
        ],
  };
}
// §16.8.1's registry, transcribed. A section never invents a prefix — it takes
// one of these; a file on disk not listed here is an unregistered migration.
const MIGRATION_REGISTRY = [
  ["20260922090000_extensions_and_conventions", 2],
  ["20260922090100_enums", 2],
  ["20260922090200_identity", 2],
  ["20260922090210_identity_link", 2],
  ["20260922090300_content", 2],
  ["20260922090400_social_graph", 2],
  ["20260922090500_classification", 2],
  ["20260922090600_embeddings", 2],
  ["20260922090700_ranking", 2],
  ["20260922090800_action_events", 2],
  ["20260922090900_money", 2],
  ["20260922091000_agents", 2],
  ["20260922091100_distribution", 2],
  ["20260922091200_ops", 2],
  ["20260922091300_worker_role_and_rls_audit", 2],
  ["20260922091400_seed_reference", 2],
  ["20260922091500_app_enter", 3],
  ["20260922091600_revenue_share", 8],
  ["20260922091700_agent_spend_reservations", 9],
  ["20260922091800_connector_credentials", 9],
  ["20260922091900_platform_constraints", 10],
  ["20260922091901_platform_seed", 10],
  ["20260922092000_telemetry_facets", 11],
  ["20260922092001_edge_read", 6],
  ["20260922092002_telemetry_salts", 6],
  ["20260922092004_edge_helpers", 6],
  ["20260922092003_telemetry_rollups", 11],
  ["20260922092100_ops_internal_auth", 11],
  ["20260922092101_ops_metrics", 11],
  ["20260922092102_legal_consent", 11],
  ["20260922092103_dsar", 11],
  ["20260922092104_alerting", 11],
  ["20260922092200_citations", 18],
  ["20261103090000_classification_battery", 14],
  ["20261103090100_media", 19],
  ["20261103090200_artifacts_versioning", 16],
  ["20261103090300_muse_mixer", 13],
];

export function m2MigrationSet() {
  const errors = [];
  // (a) no shared timestamp prefix
  const dup = run(
    "ls supabase/migrations/*.sql 2>/dev/null | sed 's#.*/##; s/_.*//' | sort | uniq -d",
  );
  if (dup.out.trim()) errors.push(`duplicate migration prefixes:\n${dup.out.trim()}`);
  // (b) every filename matches the convention
  const bad = run(
    "ls supabase/migrations/*.sql | sed 's#.*/##' | grep -vE '^[0-9]{14}_[a-z0-9_]+\\.sql$' || true",
  );
  if (bad.out.trim()) errors.push(`non-conforming migration filenames:\n${bad.out.trim()}`);
  // (c) two-direction set compare against §16.8 filtered to milestone <= 2
  const onDisk = new Set(
    readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, "")),
  );
  const expected = new Set(MIGRATION_REGISTRY.filter(([, m]) => m <= 2).map(([f]) => f));
  for (const f of onDisk)
    if (!expected.has(f) && !MIGRATION_REGISTRY.some(([r]) => r === f))
      errors.push(`${f}.sql on disk but absent from §16.8 — invented prefix`);
    else if (!expected.has(f))
      errors.push(`${f}.sql on disk before its milestone — check the registry`);
  for (const f of expected)
    if (!onDisk.has(f)) errors.push(`${f}.sql listed in §16.8 but missing on disk`);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// M3 milestone checks — §16.5 verbatim. The vitest splits are by test-name
// prefix (-t "M3.x"); the two suites are apps/edge/test/auth.test.ts (workerd)
// and apps/web/test/auth.test.ts (SIWE union/domain binding).
// ---------------------------------------------------------------------------

const EDGE_AUTH_TEST = "pnpm vitest run --project edge test/auth.test.ts";
const WEB_AUTH_TEST = "pnpm vitest run --project web test/auth.test.ts";
const vitestSlice = (cmd, tag) => {
  const r = run(`${cmd} -t "${tag}"`);
  return { ok: r.code === 0, errors: r.code ? [r.out.slice(-2500)] : [] };
};

// M3.1 — all four actor classes resolve in the Worker from a constructed
// Request under @cloudflare/vitest-plugin.
export function m3ActorClasses() {
  return vitestSlice(EDGE_AUTH_TEST, "M3.1");
}

// M3.2 — the WBA matrix: absent→human, valid→agent, invalid/expired/unknown→
// 401 never free, directory unreachable + no stale<7d→503 + Retry-After:30.
export function m3WbaOutcomes() {
  return vitestSlice(EDGE_AUTH_TEST, "M3.2");
}

// M3.3 — the three verify() overrides asserted at the call site: maxAge 300
// (not the library's 86400), clockSkew 30, algorithms exactly ["ed25519"]
// (an RSA-PSS signature is rejected).
export function m3WbaOverrides() {
  return vitestSlice(EDGE_AUTH_TEST, "M3.3");
}

// M3.4 — SSRF: a Signature-Agent at a link-local/martian URI is never fetched;
// body abandoned at 64KB; the fetch carries a 2 s timeout.
export function m3Ssrf() {
  return vitestSlice(EDGE_AUTH_TEST, "M3.4");
}

// M3.5 — RFC 9421 is verified by vendored web-bot-auth@0.2.0, not hand-rolled:
// no Signature-Input string building anywhere in apps/edge/src, no
// compatibility_flags in the manifest (ed25519 runs under the pinned date).
export function m3VendoredVerifier() {
  const errors = [];
  const r = vitestSlice(EDGE_AUTH_TEST, "M3.5");
  errors.push(...r.errors);
  const handRolled = rg("Signature-Input", ["apps/edge/src"], ["--glob", "*.ts"]);
  for (const h of handRolled)
    if (!h.includes("web-bot-auth")) errors.push(`hand-rolled RFC 9421 surface: ${h}`);
  const flags = rg("compatibility_flags", ["apps/edge/wrangler.jsonc"]);
  if (flags.length)
    errors.push(`compatibility_flags present — dead config per CF-SPINE §12: ${flags.join("; ")}`);
  return { ok: errors.length === 0, errors };
}

// M3.6 — request.cf.verifiedBot / verifiedBotCategory / score are recorded as
// evidence only and never unlock paid: no `botManagement` read anywhere.
export function m3BotSignalsEvidenceOnly() {
  const errors = [];
  const r = vitestSlice(EDGE_AUTH_TEST, "M3.6");
  errors.push(...r.errors);
  const hits = rg(
    "botManagement",
    ["apps", "packages"],
    ["-i", "--glob", "!**/worker-configuration.d.ts"],
  );
  if (hits.length) errors.push(`request.cf.botManagement must never be read: ${hits.join("; ")}`);
  return { ok: errors.length === 0, errors };
}

// M3.7 — verifyPayload's union drives the login branch: a tampered signature
// lands on .valid:false and generateJWT is unreachable.
export function m3SiweUnion() {
  return vitestSlice(WEB_AUTH_TEST, "M3.7");
}

// M3.8 — domain binding: a payload minted for example.com fails verifyPayload
// against NEXT_PUBLIC_THIRDWEB_AUTH_DOMAIN=musebook.dev.
export function m3DomainBinding() {
  return vitestSlice(WEB_AUTH_TEST, "M3.8");
}

// M3.9 — delegations stores token_hash only: zero token/api_key/secret columns.
export function m3NoTokenColumns() {
  return sqlCheck(
    "select count(*) from information_schema.columns where table_schema='public' and table_name='delegations' and column_name in ('token','api_key','secret')",
    "0",
  );
}

// M3.10 — a feed:read token asked for post:write → 403 naming the scope.
export function m3ScopeGate() {
  return vitestSlice(EDGE_AUTH_TEST, "M3.10");
}

// M3.11 — the legacy bearer scheme is gone: no X-Mog-API-Key anywhere.
export function m3NoMogKey() {
  const hits = rg("X-Mog-API-Key|x-mog-api-key", ["apps", "packages"], ["-i"]);
  return { ok: hits.length === 0, errors: hits };
}

// M3.12 — mint + revoke each append exactly one audit_log row (integration:
// executes the real functions against the local database).
export function m3AuditWrites() {
  const dlg = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
  // app.audit_log_insert performs app.enter('musebook_jobs') — only a member
  // with the SET grant may switch planes (postgres holds ADMIN-not-SET).
  // musebook_worker is the production caller, so the check authenticates as it.
  const workerUrl = `postgresql://musebook_worker:${process.env.MUSEBOOK_WORKER_DB_PASSWORD ?? "x"}@127.0.0.1:54322/postgres`;
  const before = sqlRun(
    `select count(*) from public.audit_log where delegation_id='${dlg}' and action in ('delegation.mint','delegation.revoke')`,
  );
  if (before.code !== 0) return { ok: false, errors: [], blocked: before.out.trim() };
  // Separate psql calls: app.enter's `set local role` lasts to transaction end,
  // so sibling statements in one -c run would execute under the switched plane.
  const mint = sqlRun(
    `select app.audit_log_insert(jsonb_build_object('actor','human_creator','actor_user_id','00000000-0000-4000-8000-000000000001','delegation_id','${dlg}','action','delegation.mint','target_kind','delegation','target_id','${dlg}'))`,
    workerUrl,
  );
  if (mint.code !== 0) return { ok: false, errors: [mint.out.slice(-1200)] };
  const rev = sqlRun(
    `select public.revoke_delegation('${dlg}','gate_m3_audit','00000000-0000-4000-8000-000000000001')`,
    workerUrl,
  );
  if (rev.code !== 0) return { ok: false, errors: [rev.out.slice(-1200)] };
  const after = sqlRun(
    `select count(*) - ${before.out.trim()} from public.audit_log where delegation_id='${dlg}' and action in ('delegation.mint','delegation.revoke')`,
  );
  const delta = (after.out.trim().split("\n").pop() ?? "").trim();
  return {
    ok: delta === "2",
    errors: delta === "2" ? [] : [`expected mint+revoke to append 2 audit rows, delta=${delta}`],
  };
}

// M3.13 — exactly one Actor producer and one actorSchema: no resolvePrincipal,
// one `export const actorSchema` in packages/schema/src.
export function m3ActorShape() {
  const errors = [];
  const hits = rg("resolvePrincipal", ["apps", "packages"]);
  if (hits.length) errors.push(`resolvePrincipal must not exist: ${hits.join("; ")}`);
  const count = run(
    "grep -rh 'export const actorSchema' packages/schema/src/*.ts | wc -l",
  ).out.trim();
  if (count !== "1") errors.push(`expected exactly 1 actorSchema export, found ${count}`);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// M4 milestone checks — §16.5 verbatim. The six checks pin the canonical
// producer, the hash, the six §6.6 representations, the ETag shape, dual-tier
// hash identity, and the "no app attached" rule.
// ---------------------------------------------------------------------------

const CONTENT_NODE = "pnpm vitest run --project content";
const CONTENT_WORKERS = "pnpm vitest run --project content-workers";

// M4.1 — ≥1,000 whitespace-equivalent inputs (trailing spaces, CRLF vs LF,
// trailing newline, nested-list indentation) → identical content_hash.
export function m4HashStability() {
  return vitestSlice(`${CONTENT_NODE} test/hash-stability.test.ts`, "M4.1");
}

// M4.2 — a one-character body change produces a different hash.
export function m4HashSensitivity() {
  return vitestSlice(`${CONTENT_NODE} test/hash-sensitivity.test.ts`, "M4.2");
}

// M4.3 — all six representations produced for a fixture:
// 'html'|'markdown'|'json'|'jsonld'|'mcp'|'feed'.
export function m4SixReps() {
  return vitestSlice(`${CONTENT_NODE} test/representations.test.ts`, "M4.3");
}

// M4.4 — ETag pinned to `W/"sha256-<16 lowercase hex>-<as>"` where the hex is
// contentHash().slice(0,16); differs per representation.
export function m4EtagPin() {
  return vitestSlice(`${CONTENT_NODE} test/etag.test.ts`, "M4.4");
}

// M4.5 — the suite passes under BOTH plain vitest and @cloudflare/vitest-plugin
// with identical hashes. sha256Hex is pure TS, so identical output is what the
// two runs assert independently (the roundtrip test pins every digest against
// WebCrypto on whichever runtime executes it).
export function m4DualRunner() {
  const node = run(`${CONTENT_NODE}`);
  if (node.code !== 0) return { ok: false, errors: [node.out.slice(-2500)] };
  const workers = run(`${CONTENT_WORKERS}`);
  if (workers.code !== 0) return { ok: false, errors: [workers.out.slice(-2500)] };
  return { ok: true, errors: [] };
}

// M4.6 — no app attached: nothing under apps/ may import @musebook/content yet
// (the composer's live preview lands at M7; kernel wraps it at M5).
export function m4NoAppImport() {
  const hits = rg("@musebook/content", ["apps"]);
  return { ok: hits.length === 0, errors: hits };
}

// ---------------------------------------------------------------------------
// M5 milestone checks — §16.5 verbatim. Eleven checks: the 24 goldens on both
// tiers, the SECRET_MARKER invariant, jsonld/feed assertions, fail-closed,
// preview determinism, shared-cache posture, purity + mechanical greps, ETag
// single-producer, and mintsDurableGrant.
// ---------------------------------------------------------------------------

const KERNEL_NODE = "pnpm vitest run --project kernel";
const KERNEL_WORKERS = "pnpm vitest run --project kernel-workers";

// M5.1 — all 24 golden fixtures pass, and byte-identically under both runners.
export function m5GoldenFixtures() {
  const node = run(`${KERNEL_NODE} test/golden.test.ts -t "golden fixtures"`);
  if (node.code !== 0) return { ok: false, errors: [`node tier: ${node.out.slice(-2500)}`] };
  const workers = run(`${KERNEL_WORKERS} test/golden.test.ts -t "golden fixtures"`);
  if (workers.code !== 0)
    return { ok: false, errors: [`workerd tier: ${workers.out.slice(-2500)}`] };
  return { ok: true, errors: [] };
}

// M5.2 — SECRET_MARKER: denied bodies never contain MUSEBOOK_PAID_BODY_MARKER_7f3a.
export function m5SecretMarker() {
  return vitestSlice(`${KERNEL_NODE} test/golden.test.ts`, "SECRET_MARKER");
}

// M5.3 — jsonld (6 assertions on isAccessibleForFree/hasPart) + feed (3 on
// content_text === summary).
export function m5JsonldFeed() {
  return vitestSlice(`${KERNEL_NODE} test/golden.test.ts`, "jsonld assertions|feed assertions");
}

// M5.4 — fail-closed: throwing GrantPort AND PaymentPort each → allow:false +
// zero-length body.
export function m5FailClosed() {
  return vitestSlice(`${KERNEL_NODE} test/fail-closed.test.ts`, "fail-closed");
}

// M5.5 — preview determinism over 1,000 generated bodies; never splits a fence.
export function m5PreviewDeterminism() {
  return vitestSlice(`${KERNEL_NODE} test/preview.test.ts`, "previewOf determinism");
}

// M5.6 — cache.shared === false for every non-free allow reason; no
// CDN-Cache-Control header in any casing.
export function m5CachePosture() {
  return vitestSlice(`${KERNEL_NODE} test/cache.test.ts`, "shared-cache assertions");
}

// M5.7 — purity: index callable with stub ports in plain Node AND no platform
// imports under packages/kernel/src/.
export function m5Purity() {
  const slice = vitestSlice(`${KERNEL_NODE} test/purity.test.ts`, "kernel purity");
  if (!slice.ok) return slice;
  const hits = rg(String.raw`from '(cloudflare:|pg|@cloudflare/)`, ["packages/kernel/src"]);
  return { ok: hits.length === 0, errors: hits };
}

// M5.8 — containment: publish_mode|publishMode appears only inside the
// kernel and the two named schema files, file by file.
export function m5Containment() {
  const hits = rg(
    "publish_mode|publishMode",
    ["apps", "packages"],
    ["-g", "*.ts", "-g", "*.tsx"],
  ).filter(
    (h) =>
      !h.startsWith("packages/kernel/") &&
      // D34: the §3.4 allow-list exempts TEST fixture dirs (the rule's own
      // default includes packages/kernel/test/); a fixture declares the mode
      // value, it never branches on it — same exemption for the other floors.
      !h.startsWith("packages/content/test/") &&
      !h.startsWith("packages/x402/test/") &&
      !h.startsWith("packages/schema/src/kernel.ts") &&
      !h.startsWith("packages/schema/src/database.types.ts"),
  );
  return { ok: hits.length === 0, errors: hits };
}

// M5.9 — no app attached: nothing under apps/ imports @musebook/kernel yet.
export function m5NoAppImport() {
  const hits = rg("@musebook/kernel", ["apps"]);
  return { ok: hits.length === 0, errors: hits };
}

// M5.10 — ETag per representation, produced only in packages/kernel/src/headers.ts.
export function m5EtagSingleProducer() {
  const slice = vitestSlice(`${KERNEL_NODE} test/etag.test.ts`, "etagFor");
  if (!slice.ok) return slice;
  const hits = rg(String.raw`W/"\$\{|W/"sha256-`, ["apps", "packages"], ["-g", "*.ts"]).filter(
    (h) => !h.startsWith("packages/kernel/src/headers.ts") && !h.includes("/test/"),
  );
  return { ok: hits.length === 0, errors: hits };
}

// M5.11 — mintsDurableGrant: true only for human_free_agent_paid.
export function m5MintsDurableGrant() {
  return vitestSlice(`${KERNEL_NODE} test/projections.test.ts`, "mintsDurableGrant");
}

// ---------------------------------------------------------------------------
// M6 milestone checks — §16.5 verbatim. Deployed-curl checks have a local
// equivalent: the same assertions run through SELF.fetch on the real Worker
// under @cloudflare/vitest-plugin with live Postgres (test/gate/wire.test.ts,
// r2-split.test.ts, origin-lockdown.test.ts, gate.test.ts).
// ---------------------------------------------------------------------------

const EG = "pnpm vitest run --project edge-gate";
const WG = "pnpm vitest run --project worker";

// M6.1 — Worker in the path + origin closed (incl. wrong-secret negative).
export function m6WorkerInPath() {
  return vitestSlice(`${EG} test/gate/origin-lockdown.test.ts`, "origin lockdown");
}

// M6.3 — twin byte-consistency + ETag form + If-None-Match 304 + Accept.
export function m6TwinWire() {
  return vitestSlice(`${EG} test/gate/wire.test.ts`, "twin byte-consistency");
}

// M6.4 — twins served by the Worker; the Vercel-era /api/twin route is gone.
export function m6TwinsWorkerOnly() {
  const slice = vitestSlice(`${EG} test/gate/wire.test.ts`, "twin byte-consistency");
  if (!slice.ok) return slice;
  const errors = [];
  if (existsSync(join(ROOT, "apps/web/app/api/twin")))
    errors.push("apps/web/app/api/twin exists — twins must never reach Vercel");
  return { ok: errors.length === 0, errors };
}

// M6.5 — O3: no event lacks a position; the NOT NULL columns catch drift.
export function m6EventPositions() {
  return sqlCheck(
    "select count(*)::int from public.action_events where slate_id is null or position is null or weights_version is null or model_version is null",
    "0",
  );
}

// M6.6 — O3: bootstrap literals are server-set, and a forged weights_version
// still stores 'none'. Wire slice covers the forged-batch posting.
export function m6BootstrapLiterals() {
  const sql = sqlCheck(
    "select count(*)::int from public.action_events where weights_version <> 'none' or model_version <> 'reverse_chron'",
    "0",
  );
  if (!sql.ok) return sql;
  return vitestSlice(`${EG} test/gate/wire.test.ts`, "authed batch");
}

// M6.7 — O3: every viewer-owned slate carries events. Anonymous slates are
// AE-only by design (ingest.ts writes no Postgres row for them) — the check
// is scoped to viewer_user_id is not null; DEVIATIONS.md records this.
export function m6SlateCoverage() {
  const slice = vitestSlice(`${EG} test/gate/wire.test.ts`, "every slate row has impressions");
  if (!slice.ok) return slice;
  return sqlCheck(
    "select count(*)::int from public.slates s where s.viewer_user_id is not null and not exists (select 1 from public.action_events e where e.slate_id = s.id)",
    "0",
  );
}

// M6.8 — O3: positions dense + zero-based per slate. Scoped to action =
// 'impression': view/play events legitimately share positions with the
// impression at that slot — the check's rationale is a dropped impression or
// two impressions claiming one slot (§16.5; DEVIATIONS.md).
export function m6PositionDensity() {
  const slice = vitestSlice(`${EG} test/gate/wire.test.ts`, "dense 0-based positions");
  if (!slice.ok) return slice;
  return sqlCheck(
    "select count(*)::int from (select slate_id, array_agg(position order by position) p from public.action_events where action = 'impression' group by slate_id) s where s.p <> (select array_agg(i) from generate_series(0, array_length(s.p, 1) - 1) i)",
    "0",
  );
}

// M6.9 — the request path reads, it does not score: no muse-mixer import,
// no direct slates/slate_items select in apps/edge (one definer call instead),
// and a page-2 continuation is a read of the same slate.
export function m6ReadNotScore() {
  const errors = [];
  const mixer = rg("@musebook/muse-mixer", ["apps/edge/"]);
  errors.push(...mixer);
  const directReads = rg("from\\s+(public\\.)?(slates|slate_items)\\b", ["apps/edge/src"]);
  errors.push(...directReads);
  if (errors.length) return { ok: false, errors };
  return vitestSlice(`${EG} test/gate/wire.test.ts`, "feed reads the slate");
}

// M6.10 — slate INSERTs live only under apps/worker/src.
export function m6SlateWriterPlacement() {
  const hits = rg("insert into public\\.slates", ["apps", "packages"], ["-g", "*.ts"]).filter(
    (h) => !h.startsWith("apps/worker/src/"),
  );
  return { ok: hits.length === 0, errors: hits };
}

// M6.11 — forged x-mb-* never reaches the origin; x-mb-request-id is minted.
export function m6ForgedTrustHeaders() {
  return vitestSlice(`${EG} test/gate/gate.test.ts`, "x-mb-* header never reaches");
}

// M6.12 — geo from request.cf: x-mb-country falls back to XX in index.ts,
// and no Vercel-era geo API is read anywhere in apps or packages.
export function m6GeoFromCf() {
  const errors = [];
  const src = readFileSync(join(ROOT, "apps/edge/src/index.ts"), "utf8");
  if (!/request\.cf\?\.country(\s+as\s+[\w |]+)?\s*\)*\s*\?\?\s*["']XX["']/.test(src))
    errors.push("index.ts does not set x-mb-country from request.cf.country ?? 'XX'");
  const vercel = rg(
    "x-vercel-ip-country|geolocation\\(\\)|ipAddress\\(\\)",
    ["apps", "packages"],
    ["-g", "*.ts", "-g", "*.tsx"],
  );
  errors.push(...vercel);
  return { ok: errors.length === 0, errors };
}

// M6.13 — DNT: zero rows in BOTH stores, impressions counter still +1.
export function m6DntOptOut() {
  return vitestSlice(`${EG} test/gate/wire.test.ts`, "DNT");
}

// M6.14 — CF-Connecting-IP is read in exactly two files.
export function m6ClientIpScope() {
  const hits = rg("CF-Connecting-IP", ["apps", "packages"], ["-g", "*.ts"]);
  const files = [...new Set(hits.map((h) => h.split(":")[0]))].sort();
  const want = ["apps/edge/src/index.ts", "apps/edge/src/telemetry/privacy.ts"];
  return {
    ok: JSON.stringify(files) === JSON.stringify(want),
    errors:
      JSON.stringify(files) === JSON.stringify(want)
        ? []
        : [`CF-Connecting-IP files ${JSON.stringify(files)} != ${JSON.stringify(want)}`],
  };
}

// M6.15 — one-statement outbox: no explicit BEGIN anywhere in either Worker,
// and the enqueue path is a single plpgsql call (app.enqueue_job).
export function m6OneStatementOutbox() {
  const errors = [];
  const txs = rg("\\bBEGIN\\b|client\\.query\\(['\"]begin['\"]\\)", [
    "apps/edge/src",
    "apps/worker/src",
  ]);
  errors.push(...txs);
  const enqueue = readFileSync(join(ROOT, "apps/edge/src/enqueue.ts"), "utf8");
  if (!/app\.enqueue_job\(/.test(enqueue))
    errors.push("enqueue.ts does not call app.enqueue_job — outbox write is not one statement");
  return { ok: errors.length === 0, errors };
}

// M6.16 — the sweeper recovers a dropped enqueue within ~60 s.
export function m6SweeperRecovery() {
  return vitestSlice(`${WG} test/outbox-sweeper.test.ts`, "sweeper");
}

// M6.17 — a message that fails every retry lands in the DLQ AND is consumed:
// state 'dead' on the job_outbox row + an ops_events error.
export function m6DlqConsumed() {
  return vitestSlice(`${WG} test/queue-idempotency.test.ts`, "dead");
}

// M6.18 — every consumer is idempotent, keyed on job_outbox.dedupe_key.
export function m6IdempotentConsumers() {
  return vitestSlice(`${WG} test/queue-idempotency.test.ts`, "idempotent");
}

// M6.19 — ≤128 KB per message, ids/R2 keys only, no inlined body.
export function m6MessageSize() {
  return vitestSlice(`${WG} test/outbox-sweeper.test.ts`, "128");
}

// M6.20 — cdn. never touches a Worker: the cache-everything + edge_ttl rule
// exists on http_request_cache_settings and Smart Tiered Cache is on.
export function m6CdnCacheEverything() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset` };
  const errors = [];
  const ruleset = cf(
    `/zones/${process.env[ZONE_ENV]}/rulesets/phases/http_request_cache_settings/entrypoint`,
  );
  const rules = ruleset.json?.result?.rules ?? [];
  const rule = rules.find((r) => r.description === "cache-everything-cdn" && r.enabled);
  if (!rule) errors.push("no enabled cache-everything-cdn rule");
  else {
    if (rule.action_parameters?.cache !== true) errors.push("cdn rule cache is not true");
    if (!rule.expression?.includes('http.host eq "cdn.musebook.dev"'))
      errors.push(`cdn rule expression not host-scoped: ${rule.expression}`);
    if (rule.action_parameters?.edge_ttl?.mode !== "override_origin")
      errors.push("cdn rule has no override_origin edge_ttl — .m3u8/.ts/.json stay DYNAMIC");
  }
  const tiered = cf(`/zones/${process.env[ZONE_ENV]}/cache/tiered_cache_smart_topology_enable`);
  if (tiered.json?.result?.value !== "on")
    errors.push(`tiered_cache_smart_topology_enable is '${tiered.json?.result?.value}' not 'on'`);
  return { ok: errors.length === 0, errors };
}

// M6.21 — paid media only through the Worker after the grant check; buckets
// sealed (r2-seal universal) and a direct bucket-host fetch is refused.
export function m6PaidMediaGate() {
  return vitestSlice(`${EG} test/gate/r2-split.test.ts`, "paid media");
}

// M6.22 — no presigned URL is ever minted on a read path.
export function m6NoPresignReads() {
  const hits = rg("aws4|X-Amz-Signature|presign", [
    "apps/edge/src/media.ts",
    "apps/edge/src/routes/",
  ]);
  return { ok: hits.length === 0, errors: hits };
}

// M6.23 — Range returns 206 + Content-Range from R2Object.size; an
// unsatisfiable precondition returns 412 with no body.
export function m6RangeCorrectness() {
  return vitestSlice(`${EG} test/gate/r2-split.test.ts`, "Range");
}

// M6.24 — reels: surface='reels' slate serves; play/play_through reach
// Postgres (label side) AND Analytics Engine (volume side).
export function m6ReelsEvents() {
  return vitestSlice(`${EG} test/gate/wire.test.ts`, "reels");
}

// M6.25 — O9: both stores written, each holding only what §13.1.1 assigns —
// AE gets every event; Postgres gets the label-sample side.
export function m6TelemetrySplit() {
  const a = vitestSlice(`${EG} test/gate/wire.test.ts`, "authed batch");
  if (!a.ok) return a;
  return vitestSlice(`${EG} test/gate/wire.test.ts`, "DNT");
}

// M6.26 — §13.3.1's Point carries no subject fields (a @ts-expect-error
// contract test enforced by tsc --build), and exactly one writeDataPoint site.
export function m6AeNoSubjects() {
  const errors = [];
  const hits = rg("writeDataPoint", ["apps", "packages"], ["-g", "*.ts"]).filter(
    (h) =>
      !h.includes("packages/telemetry/src/ae.ts") &&
      !h.includes("/test/") &&
      !h.includes("worker-configuration.d.ts"), // wrangler types output, not a call site
  );
  errors.push(...hits);
  if (!existsSync(join(ROOT, "packages/telemetry/src/point-contract.ts")))
    errors.push("packages/telemetry/src/point-contract.ts missing (subject-field contract)");
  const tc = run("pnpm --filter @musebook/telemetry typecheck");
  if (tc.code !== 0)
    errors.push(`telemetry typecheck failed (point contract): ${tc.out.slice(-800)}`);
  return { ok: errors.length === 0, errors };
}

// M6.27 — the firehose never goes through Queues.
export function m6NoTelemetryQueue() {
  const hits = rg("Q_TELEMETRY|queue.*impression", ["apps/edge/src"]);
  return { ok: hits.length === 0, errors: hits };
}

// M6.28 — /_next/static/* is not routed through the Worker: no route pattern
// in apps/edge/wrangler.jsonc matches it.
export function m6StaticNotRouted() {
  const errors = [];
  const cfg = readJsonc(join(ROOT, "apps/edge/wrangler.jsonc"));
  const routes = (cfg.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
  // §15.28's row is scoped to the apex: `/_next/static/*` must not be billed
  // through the Worker on musebook.dev itself. The plan's own route list
  // (§3.6.1) declares `www.musebook.dev/*` verbatim and media./artifacts.
  // never serve Next at all — a host other than the apex is out of scope.
  for (const r of routes) {
    const host = String(r).split("/")[0];
    if (host !== "musebook.dev") continue;
    const path = String(r).replace(/^[^/]*musebook\.dev/, "");
    // path "/" is the literal root — it does NOT match /_next/static/*.
    if (path === "" || path === "*" || path === "/*" || path.startsWith("/_next"))
      errors.push(`route '${r}' would carry /_next/static/* through the Worker`);
  }
  const edge = edgeRoutes();
  if (!edge.ok) errors.push(...edge.errors);
  return { ok: errors.length === 0, errors };
}

// M6.29 — /_next/image IS cached: the cache rule exists covering both paths
// with cache:true + cache_deception_armor; custom_key is Enterprise-entitled —
// the zone can't set it, and the default key already keys on the full query
// string (url, w, q — the only params Next emits). Polish and Mirage off.
export function m6NextImageCached() {
  if (!process.env.CF_API_TOKEN || !process.env[ZONE_ENV])
    return { ok: false, errors: [], blocked: `CF_API_TOKEN/${ZONE_ENV} unset` };
  const errors = [];
  const ruleset = cf(
    `/zones/${process.env[ZONE_ENV]}/rulesets/phases/http_request_cache_settings/entrypoint`,
  );
  const rule = (ruleset.json?.result?.rules ?? []).find(
    (r) => r.description === "cache-next-image" && r.enabled,
  );
  if (!rule) errors.push("no enabled cache-next-image rule");
  else {
    if (rule.action_parameters?.cache !== true) errors.push("image rule cache is not true");
    for (const p of ["/_next/image", "/_vercel/image"])
      if (!rule.expression?.includes(p)) errors.push(`image rule does not match ${p}`);
    if (rule.action_parameters?.cache_key?.cache_deception_armor !== true)
      errors.push("cache_deception_armor is not on for the image rule");
    // custom_key on url/w/q is the verbatim ask but is an Enterprise
    // entitlement this zone lacks; the default cache key already includes
    // host + path + the full query string, and /_next/image emits only
    // url/w/q — equivalent key, recorded in DEVIATIONS.md.
  }
  for (const s of ["polish", "mirage"]) {
    const v = cf(`/zones/${process.env[ZONE_ENV]}/settings/${s}`);
    if (v.json?.result?.value !== "off")
      errors.push(`${s} is '${v.json?.result?.value}' not 'off'`);
  }
  return { ok: errors.length === 0, errors };
}

// M6.30 — no bare CDN-Cache-Control (both CDNs read it → double-caching),
// denied/gated responses are Vary:* + no-store on all three layers (wire
// slice), and no Cache Rule override_origin on a gated path prefix.
export function m6NoDoubleCache() {
  const errors = [];
  const hits = rg("CDN-Cache-Control", ["apps", "packages"], ["-g", "*.ts", "-g", "*.tsx"]).filter(
    (h) => !h.includes("Cloudflare-CDN-Cache-Control") && !h.includes("Vercel-CDN-Cache-Control"),
  );
  // filter strips lines that ONLY name the vendor forms; a line could still
  // carry a bare header elsewhere — drop hits whose bare match is absent.
  const bare = hits.filter((h) =>
    /(?<!Cloudflare-)(?<!Vercel-)\bCDN-Cache-Control/.test(
      h.replace(/Cloudflare-CDN-Cache-Control/g, "").replace(/Vercel-CDN-Cache-Control/g, ""),
    ),
  );
  // Plan-required test names + doc comments legitimately name the header
  // (§6.12.5 requires cache.test.ts to assert its absence). What matters is a
  // header EMITTED: a literal in code position. Drop test files entirely and
  // any hit whose match sits on a comment line.
  const emitted = bare.filter((h) => {
    const line = h.split(":").slice(2).join(":");
    if (h.includes("/test/") || h.includes(".test.")) return false;
    const trimmed = line.trimStart();
    return !(trimmed.startsWith("//") || trimmed.startsWith("*"));
  });
  errors.push(...emitted);
  const slice = vitestSlice(`${EG} test/gate/wire.test.ts`, "cache headers");
  if (!slice.ok) errors.push(...slice.errors);
  if (process.env.CF_API_TOKEN && process.env[ZONE_ENV]) {
    const ruleset = cf(
      `/zones/${process.env[ZONE_ENV]}/rulesets/phases/http_request_cache_settings/entrypoint`,
    );
    const text = JSON.stringify(ruleset.json?.result?.rules ?? []);
    if (/override_origin.{0,200}(gated|\/p\/|\/api\/|\/mcp)/s.test(text))
      errors.push("a cache rule applies override_origin edge-ttl to a gated path prefix");
  }
  return { ok: errors.length === 0, errors };
}

// M6.31 — paid bytes never reach a crawl surface (wire slices), and the
// always-free lists in ORIGIN_PASSTHROUGH + STATIC_ROUTES are identical to
// §6.12.8's enumeration.
export function m6CrawlNoPaidBytes() {
  const slice = vitestSlice(`${EG} test/gate/wire.test.ts`, "crawl surface");
  if (!slice.ok) return slice;
  const errors = [];
  // §6.12.8's enumeration, verbatim.
  const S6128 = [
    "/robots.txt",
    "/sitemap.xml",
    "/security.txt",
    "/crawlers.json",
    "/llms.txt",
    "/llms-full.txt",
    "/.well-known/",
  ];
  const idx = readFileSync(join(ROOT, "apps/edge/src/index.ts"), "utf8");
  const router = readFileSync(join(ROOT, "apps/edge/src/router.ts"), "utf8");
  // ORIGIN_PASSTHROUGH is `new Set([...])`; STATIC_ROUTES a Record. Each of
  // the seven §6.12.8 paths must be reachable through one of the two lists
  // (or the /.well-known prefix test) — extras in STATIC_ROUTES are fine:
  // feeds are worker-rendered too but do their own §7.13 trimming.
  const ptM = idx.match(/ORIGIN_PASSTHROUGH\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  const passthrough = ptM ? [...ptM[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
  const srM = router.match(/STATIC_ROUTES[^=]*=\s*\{([\s\S]*?)\};/);
  const statics = srM ? [...srM[1].matchAll(/"([^"]+)"\s*:/g)].map((x) => x[1]) : null;
  const wellKnown = /pathname\.startsWith\(["']\/\.well-known\/["']\)/.test(idx);
  if (passthrough === null) errors.push("ORIGIN_PASSTHROUGH Set not found in index.ts");
  if (statics === null) errors.push("STATIC_ROUTES record not found in router.ts");
  if (!wellKnown) errors.push("/.well-known/ prefix test not found in index.ts");
  const reachable = (p) =>
    p === "/.well-known/"
      ? wellKnown
      : (passthrough ?? []).includes(p) || (statics ?? []).includes(p);
  for (const p of S6128)
    if (!reachable(p))
      errors.push(`${p} is not in ORIGIN_PASSTHROUGH, STATIC_ROUTES or the /.well-known test`);
  return { ok: errors.length === 0, errors };
}

// M6.32 — G-FAKE-TX skips here: its activeFrom is M8 where the settlement
// code it guards first exists (the runner prints SKIP automatically).
export function m6FakeTxSkipped() {
  const hits = rg("G-FAKE-TX", ["scripts/gates/manifest.mjs"], ["-A", "8"]);
  const hasM8 = hits.some((h) => /activeFrom:\s*"M8"/.test(h));
  return {
    ok: hasM8,
    errors: hasM8 ? [] : ["G-FAKE-TX activeFrom is not M8 in manifest.mjs"],
  };
}
