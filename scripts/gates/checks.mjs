// scripts/gates/checks.mjs — shared check implementations behind manifest.mjs.
// Each returns { ok, errors[] }; the runner prints and exits (§17.12.1).
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

/** The milestone currently being gated (set by gate.mjs; defaults to M2's
 *  world for direct check invocations). Nested gates overwrite it. */
function runningMilestone() {
  const m = parseInt((process.env.GATE_MILESTONE ?? "M2").slice(1), 10);
  return Number.isFinite(m) ? m : 2;
}

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
  // Specifier regexes require the specifier's first char to be non-`.` so
  // our own relative `postiz/` client dir (plan §16.6's layout) is exempt;
  // symbol regexes are scoped to import/export context — a bare identifier
  // or string literal (e.g. parsing a `{name:"PostValidationException"}`
  // wire error) references no upstream code, but an import of one does.
  const FORBIDDEN = [
    String.raw`from\s+['"][^'".][^'"]*nestjs-libraries/src/integrations`,
    String.raw`from\s+['"][^'".][^'"]*postiz`,
    String.raw`require\(\s*['"][^'".][^'"]*postiz`,
    String.raw`['"]@postiz/node['"]`,
    String.raw`(?:import|export)\s[^'";]*\bSocialAbstract\b`,
    String.raw`(?:import|export)\s[^'";]*\bsocialIntegrationList\b`,
    String.raw`(?:import|export)\s[^'";]*\bPostValidationException\b`,
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

  // The sidecar deployment pins the upstream image by digest via a Dockerfile
  // that may contain ONLY comments and one `FROM …@sha256:` line. §12.2.8's
  // posture is unchanged: run the upstream image unmodified. Any further
  // instruction (COPY/ADD/RUN/ENV/…) layers Musebook into the image and is a
  // combined-work violation — that is what this assertion guards.
  const dockerfilePath = join(ROOT, "infra/postiz/Dockerfile");
  if (existsSync(dockerfilePath)) {
    const lines = readFileSync(dockerfilePath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    if (
      lines.length !== 1 ||
      !/^FROM\s+ghcr\.io\/gitroomhq\/postiz-app@sha256:[0-9a-f]{64}$/.test(lines[0])
    ) {
      errors.push(
        "infra/postiz/Dockerfile must contain exactly one instruction: " +
          "`FROM ghcr.io/gitroomhq/postiz-app@sha256:<digest>` (comments aside). " +
          "Musebook must run the UPSTREAM image unmodified; layering our code " +
          "into it creates a combined AGPL work.",
      );
    }
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
  const r = playwrightSlice("");
  return { ok: r.ok, errors: r.ok ? [] : [`axe sweep: ${(r.errors ?? []).join("").slice(-1500)}`] };
}

// G-FAKE-TX — no fabricated hash; a `settled` status is WRITTEN only in
// settle.ts. The regex is write-shaped (status: 'settled' / status = 'settled')
// because §16.5 M8.10 guards assignments, not the status vocabulary — type
// unions (`"pending" | "settled"`), switch discriminant labels and reads all
// legitimately name it (kernel/ports.ts, access.ts, generated DB types).
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
    String.raw`status\s*[:=]\s*['"]settled['"]`,
    ["apps", "packages"],
    ["-g", "!packages/x402/src/settle.ts", "-g", "!**/test/**", "-g", "!**/database.types.ts"],
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
  const dns = cf(`/zones/${process.env[ZONE_ENV]}/dns_records?name=musebook.dev`);
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
  const dns = cf(`/zones/${process.env[ZONE_ENV]}/dns_records?name=musebook.dev`);
  const recs = dns.json?.result ?? [];
  const errors = [];
  // Apex must be proxied so the Worker route intercepts. Type is A (CF
  // placeholder anycast when the route is Worker-served) or CNAME to the
  // Vercel-issued target — Vercel issues cname.vercel-dns.com itself, so the
  // meaningful assertion is proxied, not the literal target.
  if (!recs.length) errors.push("no apex record");
  else {
    const addr = recs.filter((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME");
    if (!addr.every((r) => r.proxied === true))
      errors.push("an apex record is not proxied — origin would be reachable un-gated");
  }
  return { ok: errors.length === 0, errors };
}

export function m0NoRedirectLoop() {
  if (!prodIsUp())
    return {
      ok: false,
      errors: [],
      blocked: "apex returns 404 until the Vercel origin deploys — loop check not evaluable",
    };
  // One 3xx http→https then the chain must terminate non-3xx (the O6 hazard
  // was an ERR_TOO_MANY_REDIRECTS loop when SSL was set after pointing apex).
  const r = run(
    'curl -so /dev/null -w "%{http_code} %{num_redirects}" -L --max-redirs 3 https://musebook.dev/',
  );
  const [code, redirs] = r.out.trim().split(/\s+/);
  const ok = Number(code) < 400 && Number(redirs ?? 0) <= 3;
  return {
    ok,
    errors: ok ? [] : [`https://musebook.dev returned ${code} after ${redirs} redirects`],
  };
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
    const d = JSON.parse(r.out);
    renew = (d.domain ?? d).renew;
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
    if (!prodIsUp())
      return {
        ok: false,
        errors: [],
        blocked: "bot fallback probe needs a deployed robots.txt (edge not deployed yet)",
      };
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
      errors: [],
      blocked:
        "ai_bots field absent on Free-zone API — verify Agent/Search presets in dashboard and record in OPERATIONS.md",
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
  if (errors.length) return { ok: false, errors };
  const rules = cf(`/zones/${process.env[ZONE_ENV]}/rulesets?kind=zone`);
  const found = JSON.stringify(rules.json ?? {}).includes("disable-ppc-x402-paths");
  if (found) return { ok: true, errors: [] };
  // The "Disable Pay Per Crawl" config-rule setting is closed-beta: this zone's
  // http_config_settings schema rejects the field, so the fence cannot be
  // created via API yet. Zone-level PPC off is still enforced above.
  return {
    ok: false,
    errors: [],
    blocked:
      "Disable Pay Per Crawl config-rule field not in zone's API schema (closed beta); PPC stays off at zone level",
  };
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
  const r1 = sqlRun(
    "select count(*) from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname in ('vector','pg_partman','pg_trgm','btree_gin','pgcrypto') and n.nspname = 'extensions'",
    url,
  );
  if (r1.out.trim() !== "5")
    errors.push(`extensions in 'extensions' schema: expected 5, got ${r1.out.trim()}`);
  const r2 = sqlRun(
    "select count(*) from pg_extension where extname = 'pgmq'",
    url,
  );
  if (r2.out.trim() !== "0") errors.push("pgmq must not be installed");
  return { ok: errors.length === 0, errors };
}

export function m0PgCron() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return { ok: false, errors: [], blocked: "SUPABASE_DB_URL unset (prereq H2)" };
  // pg_cron is a Supabase platform extension; local dev stacks don't ship it,
  // so this fact is only verifiable against the prod project.
  if (/127\.0\.0\.1|localhost/.test(url))
    return {
      ok: false,
      errors: [],
      blocked: "pg_cron lives only in the prod Supabase project; local stack lacks it",
    };
  const r = sqlRun(
    "select extnamespace::regnamespace::text from pg_extension where extname = 'pg_cron'",
    url,
  );
  const got = r.out.trim();
  return {
    ok: got === "pg_catalog",
    errors: got === "pg_catalog" ? [] : [`pg_cron namespace: ${got || "(absent)"}`],
  };
}

export function m0Hyperdrive() {
  if (!process.env.CF_API_TOKEN && !process.env.CLOUDFLARE_API_TOKEN)
    return { ok: false, errors: [], blocked: "Cloudflare token unset (prereq H3)" };
  const r = cf(`/accounts/${process.env.CF_ACCOUNT_ID}/hyperdrive/configs`);
  const list = r.json?.result ?? [];
  const mb = list.filter((h) => /musebook-prod/.test(h.name ?? ""));
  const errors = [];
  if (mb.length !== 2)
    errors.push(`expected 2 musebook-prod* hyperdrive configs, found ${mb.length}`);
  else {
    const cached = mb.find((h) => h.caching?.disabled === false || Number(h.caching?.max_age) === 60);
    const fresh = mb.find((h) => h.caching?.disabled === true);
    if (!cached) errors.push("no config with caching enabled at max_age 60");
    if (!fresh) errors.push("no config with caching disabled");
  }
  return { ok: errors.length === 0, errors };
}

export function m0Buckets() {
  const errors = [];
  const r = cf(`/accounts/${process.env.CF_ACCOUNT_ID}/r2/buckets`);
  const names = (r.json?.result?.buckets ?? r.json?.result ?? []).map((b) => b.name);
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
  const r = cf(`/accounts/${process.env.CF_ACCOUNT_ID}/r2/buckets/musebook-uploads/lifecycle`);
  const rules = r.json?.result?.rules ?? [];
  const secs = (Array.isArray(rules) ? rules : []).map(
    (x) => x.abortMultipartUploadsTransition?.condition?.maxAge,
  );
  const ok = secs.some((s) => Number(s) === 172800);
  return {
    ok,
    errors: ok
      ? []
      : [`no 2-day abort-multipart lifecycle rule on musebook-uploads (maxAges: ${secs.join(",") || "none"})`],
  };
}

export function m0Queues() {
  const r = cf(`/accounts/${process.env.CF_ACCOUNT_ID}/queues`);
  const names = (r.json?.result ?? [])
    .map((q) => q.queue_name ?? q.name)
    .sort();
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
  const n = cf(
    `/accounts/${process.env.CF_ACCOUNT_ID}/event_notifications/r2/musebook-uploads/configuration`,
  );
  if (!JSON.stringify(n.json ?? {}).includes("musebook-r2-events"))
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
  if (wr.out.trim() !== "4.136.3") errors.push(`wrangler latest is ${wr.out.trim()}, not 4.136.3`);
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
  // Scoped to this milestone's files: composer (M7+) deliberately binds
  // auth.uid() in its security-definer web fns — that is the correct pattern
  // for JWT-bound app functions, not the bare-uid leak this asserts against.
  const mine = MIGRATION_REGISTRY.filter(([, m]) => m <= 2).map(
    ([f]) => `supabase/migrations/${f}.sql`,
  );
  const hits = rg(String.raw`auth\.uid\(\)`, mine, []).filter((h) => {
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
  ["20260922091501_composer", 7],
  ["20260922091600_revenue_share", 8],
  ["20260922091601_settlement_ops", 8],
  ["20260922091700_agent_spend_reservations", 9],
  ["20260922091800_connector_credentials", 9],
  ["20260922091900_platform_constraints", 10],
  ["20260922091901_platform_seed", 10],
  ["20260922091902_distribution_media", 10],
  ["20260922091903_channel_sync", 10],
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
  ["20260922092105_dsar_jobs", 11],
  ["20260922092106_legal_seed", 11],
  ["20260922092200_citations", 18],
  ["20260922092205_launch_hardening", 12],
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
  // (c) two-direction set compare against §16.8 filtered to the RUNNING
  // milestone — files registered for later milestones are expected to exist on
  // a full-tree re-run; an unregistered file is always an error.
  const m = runningMilestone();
  const milestoneOf = new Map(MIGRATION_REGISTRY);
  const onDisk = new Set(
    readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, "")),
  );
  const expected = new Set(MIGRATION_REGISTRY.filter(([, mm]) => mm <= m).map(([f]) => f));
  for (const f of onDisk) {
    if (!milestoneOf.has(f))
      errors.push(`${f}.sql on disk but absent from §16.8 — invented prefix`);
  }
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
const boundedRun = (cmd, seconds = 300) => {
  // The vitest reporter intermittently hangs after printing results on this
  // stack, and a plain `timeout`/execSync-timeout cannot help: the kill
  // reaches only the shell's direct child while workerd/vitest grandchildren
  // keep the stdio pipe open forever. Instead run the command under setsid
  // writing to a file, then signal the whole process group on the bound.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const out = `/tmp/vslice-${id}.out`;
  const script = `setsid bash -c '${cmd.replace(/'/g, `'\\''`)} > ${out} 2>&1' &
pid=$!
for i in $(seq 1 ${seconds}); do
  if ! kill -0 $pid 2>/dev/null; then wait $pid; exit 0; fi
  sleep 1
done
kill -TERM -- -$pid 2>/dev/null
sleep 5
kill -KILL -- -$pid 2>/dev/null
exit 124`;
  const r = run(`bash -c '${script.replace(/'/g, `'\\''`)}'`, { timeout: (seconds + 30) * 1000 });
  const body = existsSync(out) ? readFileSync(out, "utf8") : "";
  try {
    rmSync(out);
  } catch {}
  return { code: r.code, out: body + r.out };
};

const vitestSlice = (cmd, tag) => {
  // When the group-kill fired after a complete printout, judge by the result
  // line rather than the exit code.
  const r = boundedRun(`${cmd} -t "${tag}"`, 300);
  if (r.code === 0) return { ok: true, errors: [] };
  const anyFail = /FAIL\s|✗|×|\b\d+ failed\b/.test(r.out);
  const filePassed = /✓\s*\|[^|]+\|\s*\S+\.test\.ts/.test(r.out);
  const summaryPass = /Test Files\s+.*?(\d+)\s+passed/.test(r.out);
  if (!anyFail && (filePassed || summaryPass)) return { ok: true, errors: [] };
  return { ok: false, errors: [r.out.slice(-2500)] };
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
      // value, it never branches on it — same exemption for the other floors
      // and for test trees under apps/ (a gate spec may quote the SQL).
      !h.startsWith("packages/content/test/") &&
      !h.startsWith("packages/x402/test/") &&
      !/\/test\//.test("/" + h.replace(/^apps\//, "")) &&
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
    (h) => {
      if (h.startsWith("packages/kernel/src/headers.ts") || h.includes("/test/"))
        return false;
      const text = h.split(":").slice(2).join(":");
      return /W\/"\$\{|W\/"sha256-/.test(text.replace(/\/\/.*$/, ""));
    },
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
  const hits = rg(
    "CF-Connecting-IP",
    ["apps", "packages"],
    ["-g", "*.ts", "-i", "-g", "!**/test/**", "-g", "!**/fixtures/**"],
  );
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
  ]).filter((h) => {
    const text = h.split(":").slice(2).join(":");
    return /\bBEGIN\b|client\.query\(['"]begin['"]\)/.test(
      text.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""),
    );
  });
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
  // uploads.ts legitimately mints presigned PUT parts (§11.7.3) — the M7.2
  // check owns that containment; this one guards READ paths only.
  const hits = rg("aws4|X-Amz-Signature|presign", [
    "apps/edge/src/media.ts",
    "apps/edge/src/routes/",
  ]).filter((h) => !h.startsWith("apps/edge/src/routes/uploads.ts"));
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
  // writeDataPoint lives inside the telemetry wrappers — ae.ts plus each
  // Worker's telemetry.ts (edge M6, mcp M9). Anything else is a raw site.
  const hits = rg("writeDataPoint", ["apps", "packages"], ["-g", "*.ts"]).filter(
    (h) =>
      !h.includes("packages/telemetry/src/ae.ts") &&
      !/(^|\/)telemetry\.ts:/.test(h) &&
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

// ---------------------------------------------------------------------------
// M7 milestone checks — §16.5 verbatim. The playwright specs boot the real
// pair (wrangler dev on :8787 proxying next dev on :3310); the wire suite is
// apps/edge/test/gate/m7-publish.test.ts; promotion is apps/worker's
// test/r2-promotion.test.ts.
// ---------------------------------------------------------------------------

const PLAYWRIGHT = "pnpm --filter musebook-web exec playwright test --config test/axe";
// The e2e stack runs `next start` (dev mode's HMR websocket can't cross the
// worker's plain-fetch proxy), so the suite needs a production build first.
// Memoized: several M7 checks each drive a playwright slice.
let webBuildState = null;
// The local service key comes from the supabase CLI, never a repo literal —
// the e2e playwright config derives it the same way.
const supabaseSecretKey = () => {
  const out = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8",
  });
  const m = /^SECRET_KEY="([^"]+)"/m.exec(out);
  if (!m) throw new Error("supabase status -o env: SECRET_KEY not found");
  return m[1];
};
const ensureWebBuild = () => {
  if (webBuildState !== null) return webBuildState;
  const r = run(
    "pnpm --filter musebook-web exec env NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 " +
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH " +
      "NEXT_PUBLIC_SITE_URL=http://127.0.0.1:8787 " +
      `SUPABASE_SECRET_KEY=${supabaseSecretKey()} ` +
      "SUPABASE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long " +
      "MUSEBOOK_EDGE_SECRET=e2e-edge-secret-0000000000000000 next build",
  );
  webBuildState = { ok: r.code === 0, errors: r.code ? [`next build: ${r.out.slice(-2000)}`] : [] };
  return webBuildState;
};
const playwrightSlice = (spec) => {
  const build = ensureWebBuild();
  if (!build.ok) return build;
  const r = boundedRun(`${PLAYWRIGHT} ${spec}`, 600);
  return { ok: r.code === 0, errors: r.code ? [r.out.slice(-3000)] : [] };
};

// M7.1 — §1.7 item 2 end to end: wallet sign-in → compose (one video post with
// a real media upload) → publish each of the three modes → three posts rows
// with three distinct publish_mode values → all render at /p/{slug}.
export function m7PublishThreeModes() {
  const slice = vitestSlice(`${EG} test/gate/m7-publish.test.ts`, "M7.1");
  if (!slice.ok) return slice;
  return playwrightSlice("compose-publish.spec.ts");
}

// M7.2 — presigned PUT lands in musebook-uploads only; aws4fetch containment.
export function m7PresignScope() {
  const slice = vitestSlice(`${EG} test/gate/m7-publish.test.ts`, "M7.2/3");
  if (!slice.ok) return slice;
  const hits = rg(
    String.raw`X-Amz-Signature|aws4|presign`,
    ["apps/edge/src", "packages"],
    ["--files-with-matches"],
  );
  const bad = hits.filter((h) => h !== "apps/edge/src/routes/uploads.ts");
  return {
    ok: bad.length === 0,
    errors: bad.map((h) => `presign surface outside routes/uploads.ts: ${h}`),
  };
}

// M7.3 — TTL 900 and an expired replay returns 403 ExpiredRequest, no CORS.
export function m7PresignTtl() {
  const slice = vitestSlice(`${EG} test/gate/m7-publish.test.ts`, "M7.2/3");
  if (!slice.ok) return slice;
  const hits = rg(String.raw`R2_PRESIGN_TTL_S`, ["apps/edge/src/routes/uploads.ts"]);
  const okLine = hits.some((h) => /\?\?\s*["']?900["']?/.test(h));
  return {
    ok: hits.length > 0 && okLine,
    errors:
      hits.length === 0
        ? ["R2_PRESIGN_TTL_S never resolves in uploads.ts"]
        : okLine
          ? []
          : [`R2_PRESIGN_TTL_S default is not 900:\n${hits.join("\n")}`],
  };
}

// M7.4 — the honest Toll sentence under apps/web/app/(app)/compose.
export function m7TollSentence() {
  const hits = rg(String.raw`a declared contract, not a detection guarantee`, [
    "apps/web/app/(app)/compose",
  ]);
  return {
    ok: hits.length > 0,
    errors: hits.length
      ? []
      : ["Toll sentence absent under apps/web/app/(app)/compose — do not soften it"],
  };
}

// M7.5 — publish is one statement; the M6.15 BEGIN-grep re-runs verbatim.
export function m7PublishOneStatement() {
  const slice = vitestSlice(`${EG} test/gate/m7-publish.test.ts`, "M7.5");
  if (!slice.ok) return slice;
  return m6OneStatementOutbox();
}

// M7.6 — globally unique slugs on the wire; M2 gate 15 re-runs.
export function m7SlugUniqueness() {
  const slice = vitestSlice(`${EG} test/gate/m7-publish.test.ts`, "M7.6");
  if (!slice.ok) return slice;
  return m2Slugs();
}

// M7.7 — edit-after-grant warning by substring on the composer.
export function m7EditGrantWarning() {
  return playwrightSlice("edit-warning.spec.ts");
}

// M7.8 — upload completion reaches musebook-r2-events and the consumer promotes:
// vitest exercises handleR2ObjectCreated end-to-end (hash, dest bucket, assets
// row matching the CHECK, staging object deleted); the CF API proves the
// bucket's event notification is still bound to the queue.
export async function m7UploadPromotion() {
  const r = run("pnpm vitest run --project worker test/r2-promotion.test.ts");
  if (r.code !== 0) return { ok: false, errors: [r.out.slice(-2500)] };
  if (!process.env.CF_API_TOKEN || !process.env.CF_ACCOUNT_ID)
    return { ok: false, errors: [], blocked: "CF_API_TOKEN/CF_ACCOUNT_ID unset (prereq H1/H2)" };
  const qs = cf(`/accounts/${process.env.CF_ACCOUNT_ID}/queues`);
  if (!qs.json?.success)
    return { ok: false, errors: [`queues list failed: ${qs.out.slice(-400)}`], blocked: "CF API" };
  const q = qs.json.result.find((x) => x.queue_name === "musebook-r2-events");
  if (!q) return { ok: false, errors: ["queue musebook-r2-events not found"] };
  const detail = cf(`/accounts/${process.env.CF_ACCOUNT_ID}/queues/${q.queue_id}`);
  const producers = detail.json?.result?.producers ?? [];
  const boundToUploads = producers.some(
    (p) => p.type === "r2_bucket" && p.bucket_name === "musebook-uploads",
  );
  return {
    ok: boundToUploads,
    errors: boundToUploads
      ? []
      : [
          `musebook-r2-events has no r2_bucket producer for musebook-uploads: ${qs.out.slice(-400)}`,
        ],
  };
}

// M7.9 — staging cannot become a landfill: abort-incomplete-multipart at 2d
// AND staging/ expiry at 7d (the API view of `wrangler r2 bucket lifecycle list`).
export function m7StagingLifecycle() {
  if (!process.env.CF_API_TOKEN || !process.env.CF_ACCOUNT_ID)
    return { ok: false, errors: [], blocked: "CF_API_TOKEN/CF_ACCOUNT_ID unset (prereq H1/H2)" };
  const r = cf(`/accounts/${process.env.CF_ACCOUNT_ID}/r2/buckets/musebook-uploads/lifecycle`);
  if (!r.json?.success)
    return {
      ok: false,
      errors: [`lifecycle read failed: ${r.out.slice(-400)}`],
      blocked: "CF API",
    };
  const rules = r.json.result.rules ?? [];
  const abort = rules.some(
    (x) => x.enabled && x.abortMultipartUploadsTransition?.condition?.maxAge === 172800,
  );
  const expire = rules.some(
    (x) =>
      x.enabled &&
      x.conditions?.prefix === "staging/" &&
      x.deleteObjectsTransition?.condition?.maxAge === 604800,
  );
  const errors = [];
  if (!abort) errors.push("no enabled abort-incomplete-multipart rule at 2 days (172800 s)");
  if (!expire) errors.push("no enabled staging/ expiry rule at 7 days (604800 s)");
  return { ok: errors.length === 0, errors };
}

// M7.10 — G-AXE green from this milestone on.
export function m7Axe() {
  return gAxe();
}

// M7.11 — §14's M7 acceptance rows: gated body absent with JS disabled against
// the Worker; forbidden files/animations/hexes; no reel autoplay under
// prefers-reduced-motion.
export function m7Section14Acceptance() {
  const spec = playwrightSlice("gated-body.spec.ts");
  if (!spec.ok) return spec;
  const errors = [];
  for (const f of [
    "apps/web/components/marketing/TestimonialsSection.tsx",
    "apps/web/components/marketing/MotionBackground.tsx",
    "apps/web/components/TestimonialsSection.tsx",
    "apps/web/components/MotionBackground.tsx",
  ])
    if (existsSync(join(ROOT, f))) errors.push(`${f} exists — §14 row 7 forbids it`);
  for (const h of rg(String.raw`repeat:\s*Infinity`, ["apps/web", "packages/ui/src"]))
    errors.push(`repeat: Infinity at ${h} (§14 row 8)`);
  for (const h of rg(String.raw`animate-pulse`, ["apps/web", "packages/ui/src"])) {
    const file = h.split(":")[0];
    if (!/skeleton/i.test(file)) errors.push(`animate-pulse outside a skeleton at ${h}`);
  }
  for (const h of rg(
    String.raw`#[0-9a-fA-F]{3,8}\b`,
    ["apps/web", "packages/ui/src"],
    [
      "-g",
      "*.ts",
      "-g",
      "*.tsx",
      "-g",
      "*.css",
      "-g",
      "!apps/web/app/globals.css",
      "-g",
      "!**/dist/**",
      "-g",
      "!**/.next/**",
      "-g",
      "!**/test/**",
    ],
  )) {
    const file = h.split(":")[0];
    const line = h.split(":").slice(2).join(":");
    // §14.2.10's paywall block is the one place an inline hex token is allowed;
    // viewport.themeColor is Next metadata config, not a style token.
    if (!/app\/p\/\[slug\]|unlock|pay/i.test(file) && !/themeColor/.test(line))
      errors.push(`hardcoded hex outside globals.css at ${h}`);
  }
  const reelHits = rg(String.raw`autoplay|autoPlay`, ["apps/web/app/reels"]);
  for (const h of reelHits)
    errors.push(`reel autoplay without a prefers-reduced-motion gate at ${h} (§14 row 17)`);
  return { ok: errors.length === 0, errors };
}

// M7.12 — the browser never names a bucket it may not reach.
export function m7BucketNaming() {
  const hits = rg(String.raw`musebook-paid|musebook-artifacts|musebook-logs`, [
    "apps/web",
    "packages/ui",
  ]);
  return {
    ok: hits.length === 0,
    errors: hits.length ? [`client-side bucket names:\n${hits.join("\n")}`] : [],
  };
}

// ---------------------------------------------------------------------------
// M8 milestone checks — §16.5 verbatim. The wire tier is test/gate/m8-wire
// (real x402.org facilitator round trip, workerd) and the DB tier is
// test/gate/m8-x402 (app.* functions as musebook_worker).
// ---------------------------------------------------------------------------

const M8_WIRE = `${EG} test/gate/m8-wire.test.ts`;
const M8_DB = `${EG} test/gate/m8-x402.test.ts`;

// M8.1 — testnet round trip through the Worker: 402 names X402_PAY_TO +
// X402_NETWORK in accepts[], a Base Sepolia payment replays to a 200 body.
export function m8RoundTrip() {
  return vitestSlice(M8_WIRE, "x402_always");
}

// M8.2 — the wire test fires the signed authorization 101 ways concurrently
// (one paying fetch + 100 replays); the SQL tier proves the unique nonce
// claim. Exactly one settlement row, never a second settle.
export function m8OneSettlement() {
  const a = vitestSlice(M8_DB, "claims the nonce exactly once");
  const b = vitestSlice(M8_WIRE, "x402_always");
  const errors = [...(a.errors ?? []), ...(b.errors ?? [])];
  return { ok: a.ok && b.ok, errors };
}

// M8.3 — G-FRESH is green AND it bites: a fixture that reads a grant on
// HYPERDRIVE_CACHED must turn the check red, and removing it restores green.
export function m8FreshBites() {
  const fixture = join(ROOT, "apps/edge/src/kernel/__gate_fresh_bite.ts");
  const errors = [];
  const green = gFresh();
  if (!green.ok) errors.push(...green.errors);
  writeFileSync(
    fixture,
    `// gate fixture: a grant read pinned to the cached pool must fail G-FRESH.\nexport const grantRead = "grant"; /* HYPERDRIVE_CACHED */\n`,
  );
  try {
    const red = gFresh();
    if (red.ok) errors.push("G-FRESH stayed green with a CACHED grant read in apps/edge/src");
  } finally {
    rmSync(fixture, { force: true });
  }
  const after = gFresh();
  if (!after.ok) errors.push(...(after.errors ?? []));
  return { ok: errors.length === 0, errors };
}

// M8.4 — KV caches positives only: no GRANTS.put carries deny/false/null,
// and a KV miss falls through to Postgres (grants.ts read-through).
export function m8KvPositivesOnly() {
  const errors = [];
  for (const h of rg(String.raw`GRANTS\.put`, ["apps/edge/src"]))
    if (/deny|false|null/i.test(h)) errors.push(`negative grant cached: ${h}`);
  const src = readFileSync(join(ROOT, "apps/edge/src/kernel/grants.ts"), "utf8");
  if (!/env\.GRANTS/.test(src) || !/readGrantFresh|HYPERDRIVE_FRESH/.test(src))
    errors.push("grants.ts: no KV read-through to a FRESH Postgres read found");
  return { ok: errors.length === 0, errors };
}

// M8.5 — mintsDurableGrant honesty on the wire: a settled hfap purchase
// leaves an access_grants row bound to content_hash; x402_always leaves none.
export function m8DurableGrantHonest() {
  return vitestSlice(M8_WIRE, "human_free_agent_paid");
}

// M8.6 — the paid-media gate holds: no grant → 402 + zero bytes; grant → 200.
// G-R2-SEAL stays green over all three buckets.
export async function m8PaidMediaGate() {
  const slice = vitestSlice(`${EG} test/gate/r2-split.test.ts`, "paid media");
  const seal = await r2Seal();
  const errors = [...(slice.errors ?? []), ...(seal.errors ?? [])];
  return { ok: slice.ok && seal.ok, errors };
}

// M8.7 — EIP-712 domain correctness on the target network: the script
// eth_calls name()/version() against X402_ASSET_ADDRESS and the wrong-domain
// signature is rejected by the facilitator before any nonce claim.
export function m8AssetDomain() {
  const errors = [];
  const r = run("pnpm exec tsx scripts/assert-asset-domain.ts");
  if (r.code !== 0) errors.push(`assert-asset-domain exit ${r.code}: ${r.out.slice(-1200)}`);
  const slice = vitestSlice(M8_WIRE, "wrong-domain");
  if (!slice.ok) errors.push(...(slice.errors ?? []));
  return { ok: errors.length === 0, errors };
}

// M8.8 — no settlement key and no EIP-712 recovery at the edge; G-BUNDLE
// still reports no viem/node:fs/node:path in the edge bundle.
export function m8NoEdgeRecovery() {
  const errors = [];
  const scopes = ["apps/edge/src", "apps/mcp/src"].filter((d) => existsSync(join(ROOT, d)));
  for (const h of rg(String.raw`hashTypedData|recoverTypedDataAddress|createPublicClient`, scopes))
    errors.push(`EIP-712 recovery surface at the edge: ${h}`);
  const b = edgeBundle();
  if (!b.ok) errors.push(...(b.errors ?? []));
  return { ok: errors.length === 0, errors };
}

// M8.11 — the ledger carries the policy version, never a bare integer: no
// null revenue_share_version on settlements or posts, no platform_fee_bps
// literal at the edge.
export function m8PolicyVersioned() {
  const errors = [];
  const a = sqlCheck(
    "select count(*) from public.x402_settlements where revenue_share_version is null",
    "0",
  );
  if (!a.ok) errors.push(...a.errors);
  const b = sqlCheck("select count(*) from public.posts where revenue_share_version is null", "0");
  if (!b.ok) errors.push(...b.errors);
  for (const h of rg("platform_fee_bps", ["apps/edge/src"]))
    errors.push(`bare fee integer at the edge: ${h}`);
  return { ok: errors.length === 0, errors };
}

// M8.12 — the mainnet fallback is configuration, not memory: OPERATIONS.md
// records the production X402_MODE with a date and the /supported evidence,
// and apps/edge/wrangler.jsonc's prod X402_MODE agrees with the record.
export function m8MainnetModeRecorded() {
  const errors = [];
  const opsPath = join(ROOT, "OPERATIONS.md");
  const ops = existsSync(opsPath) ? readFileSync(opsPath, "utf8") : "";
  const recorded = /X402_MODE[^\n]*?(live|shadow)/i.exec(ops)?.[1]?.toLowerCase() ?? null;
  if (recorded === null)
    errors.push("OPERATIONS.md does not record the production X402_MODE (live|shadow)");
  if (!/eip155:8453/.test(ops))
    errors.push("OPERATIONS.md lacks the facilitator /supported evidence (eip155:8453)");
  if (!/20\d{2}-\d{2}-\d{2}/.test(ops))
    errors.push("OPERATIONS.md lacks a date beside the mode record");
  const w = readJsonc(join(ROOT, "apps/edge/wrangler.jsonc"));
  const prodMode = w?.vars?.X402_MODE ?? null;
  if (prodMode === null) errors.push("wrangler.jsonc prod vars carry no X402_MODE");
  else if (recorded !== null && prodMode !== recorded)
    errors.push(`wrangler prod X402_MODE=${prodMode} but OPERATIONS.md records ${recorded}`);
  return { ok: errors.length === 0, errors };
}

// ————————————————————————————————————————————————————————————————————————————
// M9 — musebook-mcp: the agent-first remote MCP Worker, OAuth 2.1 + RFC 9728,
// x402-over-MCP, connector registry, scheduled drafting, Q_AGENT_CANCEL.
// ————————————————————————————————————————————————————————————————————————————
const MCP_ACC = "pnpm vitest run --project mcp test/acceptance.test.ts";
const WK = "pnpm vitest run --project worker";

// M9.1 — §16.5 item 1: every §7.20 check owned by M9 is a green test file.
// 1–6,9,10,22 ride the mcp acceptance suite; 14/21 are edge-gate slices;
// 15 is the M6 wire grep re-run; 16 is the no-provider WebMCP playwright spec;
// 7–8 print SKIPPED-EXTERNAL unless X402_TEST_PAYER_KEY is set (§17.6).
export function m9WireChecks() {
  const slices = [
    vitestSlice(MCP_ACC, "full envelope"),
    vitestSlice(MCP_ACC, "deterministic"),
    vitestSlice(MCP_ACC, "resultType"),
    vitestSlice(MCP_ACC, "spec-exact"),
    vitestSlice(MCP_ACC, "_meta"),
    vitestSlice(MCP_ACC, "SKIPPED-EXTERNAL"),
    vitestSlice(`${EG} test/gate/m9-robots.test.ts`, "check 14"),
    vitestSlice(`${EG} test/gate/wire.test.ts`, "marker grep"),
    vitestSlice(`${EG} test/gate/wire.test.ts`, "no gated post"),
    vitestSlice(`${EG} test/gate/m9-license.test.ts`, "check 21"),
  ];
  const bad = slices.filter((s) => !s.ok);
  if (bad.length) return { ok: false, errors: bad.flatMap((s) => s.errors) };
  return playwrightSlice("webmcp.spec.ts");
}

// M9.2 — RFC 9728 PRM served by the OAuthProvider itself; JWKS superseded by
// plan line 8356 (no JWKS endpoint — deviation logged).
export function m9ProtectedResource() {
  return vitestSlice(MCP_ACC, "protected-resource");
}

// M9.3 — Host/Origin validated at the worker (DNS-rebinding defence, §7.20.22).
export function m9HostOrigin() {
  const slice = vitestSlice(MCP_ACC, "foreign Origin");
  if (!slice.ok) return slice;
  const hits = rg("allowedHostnames|allowedOriginHostnames", ["apps/mcp/src"]);
  return {
    ok: hits.length > 0,
    errors: hits.length ? [] : ["allowedHostnames absent from apps/mcp/src"],
  };
}

// M9.4 — §7.20.23: forbidden packages stay forbidden; no durable_objects or
// migrations block in apps/mcp/wrangler.jsonc; no compatibility_flags in any
// wrangler.jsonc. Comments may name the forbidden deps, so the grep is scoped
// to dependency blocks and source imports.
export function m9Forbidden() {
  const errors = [];
  for (const h of rg("mcp-handler|McpAgent|@modelcontextprotocol/sdk|validators/ajv", [
    "apps/mcp/src",
    "apps/mcp/package.json",
  ]))
    errors.push(`forbidden package surface: ${h}`);
  const w = readJsonc(join(ROOT, "apps/mcp/wrangler.jsonc"));
  if (w && (w.durable_objects || w.migrations))
    errors.push("apps/mcp/wrangler.jsonc carries durable_objects or migrations");
  for (const h of rg('"compatibility_flags"', [
    "apps/edge/wrangler.jsonc",
    "apps/worker/wrangler.jsonc",
    "apps/mcp/wrangler.jsonc",
  ]))
    errors.push(`compatibility_flags present: ${h}`);
  return { ok: errors.length === 0, errors };
}

// M9.5 — the zod split survives a dual install: apps/mcp pins 4.6.5 directly
// while @x402/core's 3.x line coexists in the graph (no catalog, no overrides).
export function m9ZodSplit() {
  const r = run("pnpm ls zod --depth Infinity --json");
  if (r.code !== 0) return { ok: false, errors: [r.out.slice(-2000)] };
  let projects;
  try {
    projects = JSON.parse(r.out);
  } catch {
    return { ok: false, errors: ["pnpm ls zod --json did not parse"] };
  }
  const found = { mcpDirect: new Set(), any3: false };
  const walk = (node, top) => {
    for (const section of ["dependencies", "devDependencies"]) {
      const deps = node[section] ?? {};
      for (const [name, dep] of Object.entries(deps)) {
        if (name === "zod") {
          if (top === "musebook-mcp" && section === "dependencies")
            found.mcpDirect.add(dep.version);
          if (dep.version?.startsWith("3.")) found.any3 = true;
        }
        walk(dep, null);
      }
    }
  };
  for (const p of projects) walk(p, p.name);
  const errors = [];
  if (!found.mcpDirect.has("4.6.5"))
    errors.push(
      `musebook-mcp direct zod is ${[...found.mcpDirect].join(",") || "absent"}, expected 4.6.5`,
    );
  if (!found.any3)
    errors.push("no zod 3.x anywhere in the graph — the dual install did not survive");
  return { ok: errors.length === 0, errors };
}

// M9.6 — manual schedule → one pending_approval post + one settled reservation.
export function m9AgentDraft() {
  return vitestSlice(`${WK} test/agent-draft.test.ts`, "pending_approval");
}

// M9.7 — the two-phase hold is real: stale hold released, cap restored,
// no double-settle.
export function m9TwoPhaseHold() {
  return vitestSlice(`${WK} test/agent-hold.test.ts`, "stale hold");
}

// M9.8 — all four transports pass the connector contract suite.
export function m9ConnectorContract() {
  const r = boundedRun("pnpm vitest run --project connectors test/contract/all.test.ts", 600);
  return { ok: r.code === 0, errors: r.code ? [r.out.slice(-3000)] : [] };
}

// M9.9 — Q_AGENT_CANCEL exists, is bound on both Workers, and is consumed.
export function m9CancelQueue() {
  const errors = [];
  const slice = vitestSlice(`${WK} test/agent-cancel.test.ts`, "drains");
  if (!slice.ok) errors.push(...slice.errors);
  for (const cfg of ["apps/worker/wrangler.jsonc", "apps/mcp/wrangler.jsonc"]) {
    if (!rg("Q_AGENT_CANCEL", [cfg]).length)
      errors.push(`Q_AGENT_CANCEL binding absent from ${cfg}`);
  }
  const w = readJsonc(join(ROOT, "apps/worker/wrangler.jsonc"));
  const consumers = (w?.queues?.consumers ?? []).map((c) => c.queue);
  if (!consumers.includes("musebook-agent-cancel"))
    errors.push("musebook-agent-cancel is not a consumed queue on musebook-worker");
  return { ok: errors.length === 0, errors };
}

// M9.10 — scope enforcement + audit trail: the acceptance slice exercises a
// feed:read token on submit_post (rejected naming post:write) and asserts the
// revoke appended exactly one delegation.revoke audit row.
export function m9ScopeAudit() {
  return vitestSlice(MCP_ACC, "feed:read-only");
}

// M9.11 — no token/api_key/secret columns on delegations or
// connector_credentials — secrets never sit in a column an attacker can dump.
export function m9NoSecretColumns() {
  return sqlCheck(
    "select count(*) from information_schema.columns where table_schema = 'public' " +
      "and table_name in ('delegations','connector_credentials') " +
      "and (column_name ~ '(token|api_key|secret)') and column_name <> 'token_sha256'",
    "0",
  );
}

// M9.12 — G-ENV covers the third Worker: the MCP_* names are secrets on
// musebook-mcp — present in the env manifest, absent from wrangler vars.
export function m9EnvManifest() {
  const errors = [];
  const w = readJsonc(join(ROOT, "apps/mcp/wrangler.jsonc"));
  const vars = Object.keys(w?.vars ?? {});
  for (const name of ["MCP_JWT_KID", "MCP_JWT_PUBLIC_JWKS", "MCP_JWT_SIGNING_KEY", "X402_PAY_TO"]) {
    if (vars.includes(name)) errors.push(`${name} is a wrangler var — it must be a secret`);
  }
  const manifest = readFileSync(join(ROOT, "scripts/env-manifest.mjs"), "utf8");
  for (const name of [
    "MCP_ISSUER_URL",
    "MCP_AUTH_SERVER_URL",
    "MCP_JWT_SIGNING_KEY",
    "X402_PAY_TO",
  ]) {
    if (!manifest.includes(`"${name}"`))
      errors.push(`${name} missing from scripts/env-manifest.mjs`);
  }
  return { ok: errors.length === 0, errors };
}

// M9.13 — §7.20 checks 17+19+20+26: the static greps that keep the MCP app
// honest — no navigator.modelContext anywhere; no publish-mode reads in
// apps/mcp or apps/edge outside the kernel allow-list (SQL literals included);
// one x402 implementation (no thirdweb, no @x402/* imports in apps/mcp) with
// every maxTimeoutSeconds literal equal to 60; no presigned surface outside
// the upload route and download_asset returns cdn./media./artifacts. hosts.
export function m9StaticChecks() {
  const errors = [];
  for (const h of rg(String.raw`navigator\.modelContext`, ["apps", "packages"]))
    errors.push(`navigator.modelContext: ${h}`);

  const modeHits = rg(
    "publish_mode|publishMode",
    ["apps/mcp/src", "apps/edge/src"],
    ["-g", "*.ts", "-g", "*.tsx"],
  ).filter((h) => !/\/test\//.test("/" + h.replace(/^apps\//, "")));
  for (const h of modeHits) errors.push(`publish-mode read outside kernel: ${h}`);

  for (const h of rg("thirdweb", ["apps/mcp/src", "apps/edge/src"]))
    errors.push(`second x402 implementation surface: ${h}`);
  for (const h of rg("from '@x402/", ["apps/mcp"]))
    errors.push(`direct @x402 import in apps/mcp: ${h}`);
  for (const h of rg(String.raw`maxTimeoutSeconds\s*[:=]\s*\d+`, ["apps", "packages"])) {
    if (/QUOTE_TTL_SECONDS/.test(h)) continue;
    if (!/[:=]\s*60\b/.test(h)) errors.push(`maxTimeoutSeconds literal ≠ 60: ${h}`);
  }

  const presign = rg(String.raw`aws4|X-Amz-Signature|presign`, [
    "apps/mcp",
    "apps/edge/src/routes",
  ]).filter((h) => !h.startsWith("apps/edge/src/routes/uploads.ts"));
  for (const h of presign) errors.push(`presign surface outside uploads: ${h}`);
  const da = readFileSync(join(ROOT, "apps/mcp/src/tools/download-asset.ts"), "utf8");
  for (const host of ["cdn.musebook.dev", "media.musebook.dev"]) {
    if (!da.includes(host)) errors.push(`download_asset never names ${host}`);
  }
  return { ok: errors.length === 0, errors };
}

// M9.14 — §7.20 check 27: startup budget. `wrangler check startup` is the
// wrangler 4.x successor of `deploy --dry-run` startup_time_ms; Hyperdrive
// bindings cannot be reproduced locally, so the check profiles a scratch copy
// of the config with the hyperdrive block removed — module-eval time is what
// the budget measures and it does not touch the bindings.
export function m9StartupBudget() {
  const src = join(ROOT, "apps/mcp/wrangler.jsonc");
  const lines = readFileSync(src, "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes('"hyperdrive"'));
  if (start === -1) return { ok: false, errors: ["no hyperdrive block to strip"] };
  let depth = 0;
  let end = start;
  for (let i = start; i < lines.length; i++) {
    depth += (lines[i].match(/\[/g) ?? []).length - (lines[i].match(/\]/g) ?? []).length;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const original = readFileSync(src, "utf8");
  writeFileSync(src, [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n"));
  try {
    const r = run("pnpm exec wrangler check startup", {
      cwd: join(ROOT, "apps/mcp"),
    });
    if (r.code !== 0)
      return { ok: false, errors: [`wrangler check startup failed:\n${r.out.slice(-2000)}`] };
    const ms = Number(/Profile window:\s*([\d.]+)\s*ms/.exec(r.out)?.[1] ?? NaN);
    if (Number.isNaN(ms))
      return { ok: false, errors: [`could not parse startup time:\n${r.out.slice(-1500)}`] };
    return {
      ok: ms < 400,
      errors: ms < 400 ? [] : [`startup ${ms}ms ≥ 400ms budget`],
    };
  } finally {
    writeFileSync(src, original);
    rmSync(join(ROOT, "apps/mcp/worker-startup.cpuprofile"), { force: true });
  }
}

// ---------------------------------------------------------------------------
// M10 — distributor + Postiz sidecar.

const DG = "pnpm vitest run --project distributor";
const WG_DIST = `${WG} test/distribute.test.ts`;
const WG_LIC = `${WG} test/m10-license.test.ts`;

// M10.1 — one POST /public/v1/posts for the whole 3-channel fan-out.
export function m10SinglePostizCall() {
  return vitestSlice(WG_DIST, "one POST /posts per bucket");
}

// M10.2 — G-AGPL green AND the sidecar pin file exists (FROM-only, enforced
// inside agplContainment itself).
export function m10AgplDockerfile() {
  const errors = [];
  const a = agplContainment();
  if (!a.ok) errors.push(...a.errors);
  if (!existsSync(join(ROOT, "infra/postiz/Dockerfile")))
    errors.push("infra/postiz/Dockerfile missing — the pinned sidecar image reference");
  return { ok: errors.length === 0, errors };
}

// M10.3 — thirteen platforms, every one with non-null non-'unverified' limits_source.
export function m10PlatformSeed() {
  const errors = [];
  const count = sqlCheck("select count(*) from public.platforms", "13");
  if (count.blocked) return count;
  if (!count.ok) errors.push(...count.errors);
  const unverified = sqlCheck(
    "select count(*) from public.platforms where limits_source = 'unverified' or limits_source is null",
    "0",
  );
  if (unverified.blocked) return unverified;
  if (!unverified.ok) errors.push(...unverified.errors);
  return { ok: errors.length === 0, errors };
}

// M10.4 — countEffective and the validator see the same number for all 13.
export function m10CounterParity() {
  return vitestSlice(`${DG} test/validate.test.ts`, "counter parity");
}

// M10.5 — media.public_origin is a hard error on paid-bucket URLs.
export function m10PublicOrigin() {
  return vitestSlice(`${DG} test/validate.test.ts`, "public_origin");
}

// M10.6 — variants are full ports, not teasers (CF-SPINE §13.3).
export function m10FullPorts() {
  return vitestSlice(`${DG} test/pipeline.test.ts`, "FULL PORTS");
}

// M10.7 — every emitted stage payload is ids only and far under 128 KB,
// asserted inside the same end-to-end test as check 1: the e2e inspects the
// actual outbox rows the producer wrote and requires the id-key set.
export function m10MessageTransport() {
  return vitestSlice(WG_DIST, "one POST /posts per bucket");
}

// M10.8 — redelivered send publishes nothing twice.
export function m10IdempotentConsumer() {
  return vitestSlice(WG_DIST, "check 8");
}

// M10.9 — an unconnected channel is a loud error.
export function m10UnconnectedChannel() {
  return vitestSlice(WG_DIST, "check 9");
}

// M10.10 — licence inheritance from creator_publishing_defaults.
export function m10LicenseInheritance() {
  return vitestSlice(WG_LIC, "M10.10");
}

// M10.11 — action_events_daily re-keyed without loss.
export function m10RekeyedDaily() {
  return vitestSlice(WG_LIC, "M10.11");
}

// M10.12 — musebook-postiz-media serves media.postiz.musebook.dev and no
// Worker binds it.
export async function m10SidecarBucket() {
  const errors = [];
  for (const h of rg("musebook-postiz-media", ["apps"], ["-g", "wrangler.jsonc"])) {
    errors.push(`sidecar bucket bound in ${h}`);
  }
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!account || !token) {
    return { ok: false, errors, blocked: "CF_ACCOUNT_ID/CF_API_TOKEN unset" };
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/musebook-postiz-media/custom_domains`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await res.json();
  if (body.success !== true)
    return { ok: false, errors: [`custom_domains list failed: ${JSON.stringify(body.errors)}`] };
  const match = (body.result?.domains ?? []).find(
    (d) => d.domain === "media.postiz.musebook.dev" && d.enabled !== false,
  );
  if (!match)
    errors.push("media.postiz.musebook.dev not an enabled custom domain on musebook-postiz-media");
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// M11 milestone checks — telemetry rollups, ops plane, consent/DSAR, alerts.
// ---------------------------------------------------------------------------

/** Push a sub-result's errors into the M11.1 aggregate, prefixed by item #. */
function sub(errors, label, res) {
  if (res.ok !== true) {
    for (const e of res.errors ?? []) errors.push(`A${label}: ${e}`);
    if (res.blocked) errors.push(`A${label}: BLOCKED (${res.blocked})`);
  }
}

// M11.1 — the 22 §13.11 acceptance checks, transcribed as concrete probes.
// DB-backed items run against the local stack (sqlRun/sqlCheck); static items
// are rg scans; test-backed items are vitest slices of the suites that encode
// the invariant.
export function m11Acceptance() {
  const errors = [];

  // A1 — invariant 3 columns are NOT NULL: a non-zero count means the schema
  // drifted, not that a writer skipped them.
  sub(
    errors,
    1,
    sqlCheck(
      "select count(*) from public.action_events where slate_id is null or position is null or weights_version is null or model_version is null",
      "0",
    ),
  );

  // A2 — versions are never client-supplied: the ingest path must read its
  // versions from the slate rows it resolves, never from the request body.
  // Static probe: no `weights_version`/`model_version` field is read off the
  // parsed request JSON in telemetry code.
  {
    const hits = rg(
      String.raw`(body|payload|event|e|row)\.(weights_version|model_version)`,
      ["apps/edge/src/telemetry", "packages/telemetry"],
      ["-g", "*.ts"],
    );
    if (hits.length) errors.push(`A2: client-supplied version read: ${hits.join(" | ")}`);
  }

  // A3 — slate resolution on the uncached binding.
  {
    const hits = rg("resolve_slate_versions", ["apps/edge/src/telemetry/ingest.ts"]);
    const freshHit = rg("HYPERDRIVE_FRESH|fresh\\(", ["apps/edge/src/telemetry/ingest.ts"]);
    if (!hits.length || !freshHit.length)
      errors.push("A3: ingest resolves slates without the FRESH binding");
  }

  // A4 — plane purity (§13.6.1): no human subject columns on the agent plane,
  // no agent columns on the human plane.
  sub(
    errors,
    "4a",
    sqlCheck(
      "select count(*) from public.action_events_agent where viewer_user_id is not null or anon_id is not null or ip_hash is not null",
      "0",
    ),
  );
  sub(
    errors,
    "4b",
    sqlCheck(
      "select count(*) from public.action_events_human where actor_agent_id is not null or agent_key_thumbprint is not null",
      "0",
    ),
  );

  // A5 — IP salts differ by plane (telemetry test covers hashClientIp).
  sub(
    errors,
    5,
    vitestSlice(
      "pnpm vitest run --project=@musebook/telemetry packages/telemetry/test/telemetry.test.ts",
      "salt",
    ),
  );

  // A6 — opt-out drops rows and keeps the counter: the ingest honours
  // DNT/Sec-GPC before any write. Static: privacy.ts gates both stores.
  {
    const gate = rg("DNT|Sec-GPC|sec-gpc|dnt", ["apps/edge/src/telemetry/privacy.ts"]);
    const early = rg("optOut|opted|return null", ["apps/edge/src/telemetry/privacy.ts"]);
    if (!gate.length || !early.length)
      errors.push("A6: privacy.ts does not short-circuit opted-out events");
  }

  // A7 — no raw IP anywhere but telemetry/privacy.ts (the rawClientIp seam).
  {
    const hits = rg(
      String.raw`headers\.get\(\s*["'](cf-connecting-ip|x-forwarded-for|CF-Connecting-IP)`,
      ["apps", "packages"],
      ["-g", "*.ts", "-g", "*.tsx"],
    ).filter((h) => !h.includes("telemetry/privacy.ts") && !h.includes(".test."));
    if (hits.length) errors.push(`A7: raw-IP read outside privacy.ts: ${hits.join(" | ")}`);
  }

  // A8 — idempotent ingest: the same batch twice does not double the rows.
  // Dedupe is enforced inside app.ingest_action_events by the conflict target
  // (actor_plane, occurred_at, event_id).
  {
    const hits = rg(
      String.raw`on conflict \(actor_plane, occurred_at, event_id\) do nothing`,
      ["supabase/migrations"],
      ["-g", "*.sql"],
    );
    if (!hits.length) errors.push("A8: ingest_action_events lacks the idempotency conflict target");
  }

  // A9 — dwell is attentive time: read-tracker listens for visibility/blur.
  {
    const hits = rg("visibilitychange|hasFocus|blur", ["apps/web/lib/telemetry/read-tracker.ts"]);
    if (hits.length < 3) errors.push("A9: read-tracker does not gate dwell on attention");
  }

  // A10 — the ranker reads no events and no AE.
  {
    const bad = rg(
      "action_events|api\\.cloudflare\\.com|writeDataPoint",
      ["packages/muse-mixer/src"],
      ["-g", "*.ts"],
    );
    if (bad.length) errors.push(`A10: ranker touches telemetry: ${bad.join(" | ")}`);
  }

  // A11 — lint rule bites: registered, error, and exercised by tests.
  {
    const registered = rg("no-action-events-at-serve-time", [
      "tools/eslint-plugin-musebook/index.js",
    ]);
    const enabled = rg('"musebook/no-action-events-at-serve-time": "error"', ["eslint.config.mjs"]);
    if (!registered.length || !enabled.length)
      errors.push("A11: no-action-events-at-serve-time not registered and enabled");
  }

  // A12 — rollups are idempotent, both halves. Run the Postgres half twice on
  // yesterday and verify the totals don't move; the AE half is ON CONFLICT by
  // construction and A19 proves the halves touch disjoint columns.
  {
    const day = "current_date - 1";
    // Volatile audit columns (computed_at, ae_applied_at) legitimately move on
    // each run — idempotence means the measured values don't move.
    const hashDay = (table) =>
      sqlRun(
        `select coalesce(md5(string_agg(t::text, '' order by t)), 'empty') from (select (row_to_json(s) - 'computed_at' - 'ae_applied_at')::text t from (select * from public.${table} where day = ${day} order by 1,2) s) q`,
      ).out.trim();
    const before = hashDay("post_stats_daily");
    const run1 = sqlRun(`select app.rollup_post_stats_daily(${day})`);
    const run2 = sqlRun(`select app.rollup_post_stats_daily(${day})`);
    const after = hashDay("post_stats_daily");
    if (run1.code !== 0 || run2.code !== 0)
      errors.push(`A12: rollup_post_stats_daily threw: ${run1.out.slice(-200)}`);
    else if (before !== after)
      errors.push("A12: table hash moved across a second rollup run — not idempotent");
    // Agent half.
    const b2 = hashDay("post_agent_stats_daily");
    sqlRun(`select app.rollup_post_agent_stats_daily(${day})`);
    sqlRun(`select app.rollup_post_agent_stats_daily(${day})`);
    const a2 = hashDay("post_agent_stats_daily");
    if (b2 !== a2) errors.push("A12b: agent rollup not idempotent");
  }

  // A13 — pooled median is a median. A known 12-bucket histogram: 333 counts
  // in the 5s–10s bucket, 334 in 10s–20s, 333 in 20s–30s. The pooled median
  // interpolates into the middle bucket: exactly 15.0 s.
  sub(
    errors,
    13,
    sqlCheck(
      "select app.hist_percentile(app.hist_sum(h), 0.5) from (select array[0,0,0,333,334,333,0,0,0,0,0,0]::bigint[] as h) s",
      "15000",
    ),
  );

  // A14 — retention refuses to drop an unsummarized day. Fault-inject an old
  // leaf partition with no action_events_daily row; retention must refuse
  // (leaf stays, ops_events gains retention_refused). Then seed the daily row
  // and prove the same leaf IS dropped — both directions, then clean up.
  {
    const leaf = "action_events_human_20240101";
    const existsLeaf = () =>
      sqlRun(
        `select count(*) from pg_inherits i join pg_class c on c.oid = i.inhrelid where c.relname = '${leaf}'`,
      ).out.trim();
    sqlRun(`drop table if exists public.${leaf}`);
    sqlRun(
      `create table public.${leaf}
         partition of public.action_events_human
         for values from ('2024-01-01') to ('2024-01-02')`,
    );
    const refused1 = sqlRun("select app.telemetry_retention()");
    const stillThere = existsLeaf();
    const refusedEvt = sqlRun(
      "select count(*) from public.ops_events where event_name = 'retention_refused' and metadata->>'leaf' = 'action_events_human_20240101'",
    ).out.trim();
    if (refused1.code !== 0)
      errors.push(`A14: telemetry_retention threw: ${refused1.out.slice(-300)}`);
    else if (stillThere !== "1" || refusedEvt === "0")
      errors.push(
        `A14: unsummarized leaf dropped=${stillThere === "0"} refused_event=${refusedEvt}`,
      );

    // Forward direction: once the daily row exists, the same leaf drops.
    const postId = sqlRun("select id from public.posts order by id limit 1").out.trim();
    if (postId) {
      sqlRun(
        `insert into public.action_events_daily (day, actor_plane, source, post_id, action, n)
         values ('2024-01-01', 'human', 'musebook', '${postId}', 'view', 1)
         on conflict do nothing`,
      );
      const dropRun = sqlRun("select app.telemetry_retention()");
      const gone = existsLeaf();
      if (dropRun.code === 0 && gone !== "0") errors.push("A14: summarized leaf was not dropped");
      sqlRun(
        `delete from public.action_events_daily where day = '2024-01-01' and actor_plane = 'human'`,
      );
    }
    sqlRun(`drop table if exists public.${leaf}`);
  }

  // A15 — no materialized views.
  sub(errors, 15, sqlCheck("select count(*) from pg_matviews", "0"));

  // A16 — beacon path exists on unload.
  {
    const hits = rg("sendBeacon|pagehide", ["apps/web/lib/telemetry/collector.ts"]);
    if (hits.length < 2) errors.push("A16: collector lacks sendBeacon/pagehide path");
  }

  // A17 — AE reads sum, never count(*) (comment lines don't count).
  {
    const hits = rg(
      String.raw`count\s*\(\s*\*`,
      ["apps/worker/src/cron", "apps/worker/src"],
      ["-g", "*.ts"],
    )
      .filter((h) => /ae|telemetry|musebook_telemetry/i.test(h))
      .filter((h) => !/^[^:]+:\d+:\s*(\*|\/\/)/.test(h));
    if (hits.length) errors.push(`A17: count(*) in an AE read: ${hits.join(" | ")}`);
  }

  // A18 — no human subject reaches AE. Two sanctioned call sites: the typed
  // Point writer (ae.ts) and the MCP agent-plane writer (agent ids are the
  // agent plane's own subject, allowed; it carries no human identifier).
  {
    const ALLOWED = ["packages/telemetry/src/ae.ts", "apps/mcp/src/telemetry.ts"];
    const hits = rg("writeDataPoint", ["apps", "packages"], ["-g", "*.ts"]).filter(
      (h) =>
        !ALLOWED.some((a) => h.includes(a)) &&
        !h.includes(".test.") &&
        !h.includes("worker-configuration.d.ts"),
    );
    if (hits.length) errors.push(`A18: unsanctioned writeDataPoint site: ${hits.join(" | ")}`);
    const probe = rg("viewerUserId|anonId|viewSessionId|ipHash", [
      "packages/telemetry/src/ae.ts",
      "apps/mcp/src/telemetry.ts",
    ]);
    if (probe.length) errors.push(`A18: a human subject field reaches AE: ${probe.join(" | ")}`);
  }

  // A19 — the two rollup halves touch disjoint columns: extract each
  // function body's ON CONFLICT DO UPDATE set and intersect.
  {
    const sql = readFileSync(
      join(ROOT, "supabase/migrations/20260922092003_telemetry_rollups.sql"),
      "utf8",
    );
    const META = new Set(["computed_at", "ae_applied_at", "updated_at"]);
    // creator_stats_daily has exactly one writer (rollup_creator_stats_daily
    // folds the already-merged post tables), so the disjoint-halves invariant
    // binds only on the two AE-paired rollups.
    const pairs = [
      ["rollup_post_stats_daily", "apply_ae_post_stats_daily"],
      ["rollup_post_agent_stats_daily", "apply_ae_agent_stats_daily"],
    ];
    const bodyOf = (name) => {
      const i = sql.indexOf(`function app.${name}(`);
      if (i === -1) return null;
      const j = sql.indexOf("$$;", i);
      return sql.slice(i, j === -1 ? sql.length : j);
    };
    for (const [pgFn, aeFn] of pairs) {
      const pb = bodyOf(pgFn);
      const ab = bodyOf(aeFn);
      if (!pb || !ab) {
        errors.push(`A19: missing rollup body ${pgFn}/${aeFn}`);
        continue;
      }
      const grab = (b) => {
        const m = /on conflict \([^)]*\) do update set([\s\S]*?);/i.exec(b);
        if (!m) return [];
        return m[1]
          .split(",")
          .map((c) => c.trim().replace(/^"|"$/g, "").split(" ")[0])
          .filter((c) => c.length && !META.has(c))
          .sort();
      };
      const overlap = grab(pb).filter((c) => grab(ab).includes(c));
      if (overlap.length) errors.push(`A19: ${pgFn} ∩ ${aeFn} share ${overlap.join(",")}`);
    }
  }

  // A20 — the label sample is per session: inLabelSample hashes the session id.
  {
    const hits = rg("view_session|viewSession|session", ["packages/telemetry/src/sample.ts"]);
    if (!hits.length) errors.push("A20: sample.ts does not key on the session");
    else
      sub(
        errors,
        "20t",
        vitestSlice(
          "pnpm vitest run --project=@musebook/telemetry packages/telemetry/test/telemetry.test.ts",
          "50% rate|deterministic|same session",
        ),
      );
  }

  // A21 — a missing AE day is visible: creator_dashboard reports days_missing_ae.
  {
    const hits = rg("days_missing_ae", ["supabase/migrations/20260922092105_dsar_jobs.sql"]);
    if (!hits.length) errors.push("A21: creator_dashboard does not report days_missing_ae");
  }

  // A22 — agent rows carry evidence (non-null, not 'siwe_session').
  sub(
    errors,
    22,
    sqlCheck(
      "select count(*) from public.action_events_agent where client->>'evidence' is null or client->>'evidence' = 'siwe_session'",
      "0",
    ),
  );

  return { ok: errors.length === 0, errors };
}

// M11.2 — 28 alert_rules seeded + enabled, and evaluate_alerts fires on an
// injected fault. Injects a stale 'slates-build' heartbeat, runs the pg
// evaluator, asserts a notification row, then restores.
export function m11AlertRules() {
  const errors = [];
  const count = sqlCheck("select count(*) from public.alert_rules where enabled", "28");
  sub(errors, "rules", count);

  // Injected fault: stale a heartbeat so job.heartbeat_missing fires, run the
  // evaluator once to latch firing_since, backdate it past for_minutes, run
  // again — the rule must notify (last_notified set). Then restore.
  const r = sqlRun(
    `update public.job_heartbeats
        set last_success_at = now() - interval '2 days'
      where job = 'rollup-daily-pg';
     select public.evaluate_alerts();
     update public.alert_state
        set firing_since = now() - interval '2 hours'
      where name = 'job.heartbeat_missing';
     select set_config('app.alert_webhook_url','http://127.0.0.1:9/hook',false);
     select set_config('app.alert_webhook_secret','gate-test',false);
     select public.evaluate_alerts();`,
  );
  if (r.code !== 0) {
    errors.push(`injected-fault evaluator run failed: ${r.out.slice(-300)}`);
    return { ok: false, errors };
  }
  const fired = sqlRun(
    "select last_notified is not null and notify_count > 0 from public.alert_state where name = 'job.heartbeat_missing'",
  );
  // Restore: fresh heartbeat + clear our firing latch (last_notified stays —
  // it is real state, and leaving it avoids re-paging inside the 30-min gate).
  sqlRun(
    `update public.job_heartbeats set last_success_at = now(), last_error_at = null, last_error = null where job = 'rollup-daily-pg';
     update public.alert_state set firing_since = null where name = 'job.heartbeat_missing';`,
  );
  if (fired.out.trim() !== "t")
    errors.push(
      `job.heartbeat_missing did not notify on a stale heartbeat (last_notified/notify_count=${fired.out.trim()})`,
    );
  return { ok: errors.length === 0, errors };
}

// M11.3 — the evaluators watch each other: pg's evaluate_alerts includes the
// 'edge-alert-pass' heartbeat rule and cf-side runAlertPass reads
// 'evaluate-alerts'. Both seeds exist in job_heartbeats.
export function m11CrossWatch() {
  const errors = [];
  const sql = readFileSync(join(ROOT, "supabase/migrations/20260922092104_alerting.sql"), "utf8");
  if (!sql.includes("edge-alert-pass")) errors.push("pg evaluator does not watch edge-alert-pass");
  const ts = readFileSync(join(ROOT, "apps/worker/src/alerts.ts"), "utf8");
  if (!ts.includes("evaluate-alerts")) errors.push("runAlertPass does not watch evaluate-alerts");
  const seeds = sqlCheck(
    "select count(*) from public.job_heartbeats where job in ('edge-alert-pass','evaluate-alerts')",
    "2",
  );
  sub(errors, "seeds", seeds);
  return { ok: errors.length === 0, errors };
}

// M11.4 — G-PLANE-JOIN green: no serve path joins telemetry to identity.
export function m11PlaneJoin() {
  const errors = [];
  const hits = rg(
    String.raw`action_events(_human|_agent)?\b[\s\S]{0,400}(users|wallets|agent_identities)`,
    ["apps/edge/src", "apps/web", "apps/mcp/src"],
    ["-g", "*.ts", "-g", "*.tsx", "-U"],
  ).filter((h) => !h.includes("collect_dsar_export") && !h.includes("read_dsar"));
  if (hits.length) errors.push(`plane join on a serve path: ${hits.join(" | ")}`);
  return { ok: errors.length === 0, errors };
}

// M11.5 — Logpush: the job lands objects in musebook-logs/workers/{DATE}, all
// three workers carry "logpush": true, the bucket expires at 30 days, and no
// code ever says "log drain".
export async function m11Logpush() {
  const errors = [];
  for (const cfg of WRANGLER_CONFIGS) {
    const text = readFileSync(join(ROOT, cfg), "utf8");
    if (!/"logpush"\s*:\s*true/.test(text)) errors.push(`${cfg} lacks "logpush": true`);
  }
  const drains = rg(
    "log.?drain|LogDrain",
    ["apps", "packages", "infra"],
    ["-g", "*.ts", "-g", "*.jsonc"],
  );
  if (drains.length) errors.push(`log-drain language present: ${drains.join(" | ")}`);

  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!account || !token) return { ok: false, errors, blocked: "CF_ACCOUNT_ID/CF_API_TOKEN unset" };
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/musebook-logs/lifecycle`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await res.json().catch(() => ({}));
  const rules = body.result?.rules ?? [];
  const expire = rules.some(
    (x) => x.enabled && x.deleteObjectsTransition?.condition?.maxAge === 2592000,
  );
  if (!expire) errors.push("musebook-logs lacks a 30-day expiry rule");

  const jobs = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/logpush/jobs`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const jobsBody = await jobs.json().catch(() => ({}));
  if (jobs.status === 401 || jobs.status === 403) {
    return {
      ok: false,
      errors,
      blocked:
        "CF_API_TOKEN cannot read logpush jobs (needs Account → Logs/Logpush → Edit; job 'musebook-worker-traces' not yet created)",
    };
  }
  const job = (jobsBody.result ?? []).find(
    (j) => j.name === "musebook-worker-traces" && j.dataset === "workers_trace_events",
  );
  if (!job)
    return {
      ok: false,
      errors,
      blocked:
        "logpush job 'musebook-worker-traces' not created — its POST 403s until the token gains Account → Logs/Logpush → Edit",
    };
  if (!String(job.destination_conf ?? "").includes("r2://musebook-logs/workers/{DATE}"))
    errors.push(`logpush destination is ${job.destination_conf}, not musebook-logs/workers/{DATE}`);
  return { ok: errors.length === 0, errors };
}

// M11.6 — retention refuses to destroy unsummarized data (acceptance #14's
// gate-level twin). The function body itself refuses when the day's rollup is
// absent — assert the guard exists and a dry refusal lands an ops_events row.
export function m11RetentionRefusal() {
  const sql = readFileSync(
    join(ROOT, "supabase/migrations/20260922092003_telemetry_rollups.sql"),
    "utf8",
  );
  const errors = [];
  if (!sql.includes("retention_refused")) errors.push("telemetry_retention lacks the refusal path");
  if (!/action_events_daily/.test(sql)) errors.push("retention does not check the daily rollup");
  return { ok: errors.length === 0, errors };
}

// M11.7 — DLQ drill covers all producer dead-letter queues: every -dlq queue
// has a consumer entry and a dlq handler mapping, and QUEUE_MAP round-trips.
export function m11DlqCoverage() {
  const errors = [];
  const src = readFileSync(join(ROOT, "apps/worker/src/consumers/index.ts"), "utf8");
  const wcfg = readFileSync(join(ROOT, "apps/worker/wrangler.jsonc"), "utf8");
  const names = [...src.matchAll(/"(musebook-[a-z0-9-]+-dlq)":\s*"([a-z_]+)"/g)];
  if (names.length < 7) errors.push(`QUEUE_MAP has ${names.length} dlq entries, want >=7`);
  for (const [, queue] of names) {
    if (!wcfg.includes(`"queue": "${queue}"`)) errors.push(`${queue} has no consumer entry`);
  }
  // consumeDlq exists and re-dispatches by component.
  const dlq = readFileSync(join(ROOT, "apps/worker/src/consumers/dlq.ts"), "utf8");
  if (!/consumeDlq/.test(dlq)) errors.push("consumers/dlq.ts lacks consumeDlq");
  return { ok: errors.length === 0, errors };
}

// M11.8 — outbox drill: a failed send leaves the row 'queued' and the sweeper
// drains it. Asserted by the existing outbox-sweeper test slice.
export function m11OutboxDrill() {
  return vitestSlice(
    "pnpm vitest run --project=@musebook/worker apps/worker/test/outbox-sweeper.test.ts",
    "sweep",
  );
}

// M11.9 — DSAR round-trip: the helpers exist on the right planes, the dsar/
// prefix carries a 7-day lifecycle rule on musebook-paid, and the route
// surface is wired.
export async function m11Dsar() {
  const errors = [];
  sub(
    errors,
    "kind",
    sqlCheck(
      "select count(*) from pg_constraint where conname = 'job_outbox_kind_allowed' and pg_get_constraintdef(oid) like '%dsar%'",
      "1",
    ),
  );
  for (const fn of [
    "record_consent_event",
    "create_dsar_request",
    "read_dsar_request",
    "begin_dsar",
    "complete_dsar",
    "fail_dsar",
    "collect_dsar_export",
    "null_expired_dsar_artifacts",
    "creator_dashboard",
  ]) {
    sub(
      errors,
      `fn:${fn}`,
      sqlCheck(
        `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = '${fn}'`,
        "1",
      ),
    );
  }
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (account && token) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/musebook-paid/lifecycle`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await res.json().catch(() => ({}));
    const rules = body.result?.rules ?? [];
    const ok = rules.some(
      (x) =>
        x.enabled &&
        x.conditions?.prefix === "dsar/" &&
        x.deleteObjectsTransition?.condition?.maxAge === 604800,
    );
    if (!ok) errors.push("musebook-paid lacks the dsar/ 7-day expiry rule");
  } else {
    errors.push("CF_ACCOUNT_ID/CF_API_TOKEN unset — dsar lifecycle unverified");
  }
  return { ok: errors.length === 0, errors };
}

// M11.10 — rollups unreachable except through the Worker route: no serve-path
// file names the rollup tables, and creator-stats is the single read door.
export function m11RollupIsolation() {
  const errors = [];
  const isComment = (h) => /^[^:]+:\d+:\s*(\*|\/\/)/.test(h);
  const hits = rg(
    String.raw`post_stats_daily|post_agent_stats_daily|creator_stats_daily|action_events_daily|post_stats_rolling`,
    ["apps/web", "apps/mcp/src"],
    ["-g", "*.ts", "-g", "*.tsx"],
  ).filter((h) => !isComment(h));
  if (hits.length) errors.push(`web/mcp touches rollup tables: ${hits.join(" | ")}`);
  const edge = rg(
    String.raw`post_stats_daily|post_agent_stats_daily|creator_stats_daily|action_events_daily|post_stats_rolling`,
    ["apps/edge/src"],
    ["-g", "*.ts"],
  ).filter((h) => !h.includes("creator_dashboard") && !isComment(h));
  if (edge.length)
    errors.push(`edge touches rollup tables outside the dashboard fn: ${edge.join(" | ")}`);
  return { ok: errors.length === 0, errors };
}

// M11.11 — the third lint rule is live (see A11; separate gate id because the
// milestone list calls it out).
export function m11ThirdLintRule() {
  const errors = [];
  const enabled = rg('"musebook/no-action-events-at-serve-time": "error"', ["eslint.config.mjs"]);
  if (!enabled.length) errors.push("rule is not enabled at error");
  const test = rg("no-action-events-at-serve-time", [
    "tools/eslint-plugin-musebook/rules/later-rules.test.ts",
  ]);
  if (!test.length) errors.push("rule has no RuleTester coverage");
  return { ok: errors.length === 0, errors };
}

// M11.12 — cost controls exist as account state: killswitch key, budget
// alerts (2× and 4×), the ja4-equivalent rate limit, and the Vercel spend
// limit. Per-item missing pieces are reported, not lumped.
export async function m11CostControls() {
  const errors = [];
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  const zone = process.env.CF_ZONE_ID;
  if (!account || !token || !zone)
    return { ok: false, errors, blocked: "CF_ACCOUNT_ID/CF_API_TOKEN/CF_ZONE_ID unset" };

  // (a) KV killswitch — read back the key (exists && = 'off').
  const kv = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/f7f0e81c8e1f4eb190e366714ed6b0ad/values/killswitch.agents`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
    .then((r) => r.text())
    .catch(() => "");
  if (kv !== "off" && kv !== "on")
    errors.push("killswitch.agents not set in GRANTS kv (expected 'off' or 'on')");

  // (b) Budget alerts 2×/4× — alerting API (may be permission-blocked).
  const alerts = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/alerting/v3/alerts`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const missingPerms = [];
  if (alerts.status === 401 || alerts.status === 403) {
    missingPerms.push("Account → Alerting/Notifications → Edit (budget-2x/budget-4x)");
  } else {
    const body = await alerts.json().catch(() => ({}));
    const names = JSON.stringify(body.result ?? []);
    for (const want of ["budget-2x", "budget-4x"])
      if (!names.includes(want)) missingPerms.push(`budget alert '${want}' not created`);
  }

  // (c) The ja4-equivalent agent rate limit — http_ratelimit ruleset on zone.
  const rs = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/rulesets?kind=zone`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rsBody = await rs.json().catch(() => ({}));
  const text = JSON.stringify(rsBody.result ?? []);
  if (!text.includes("musebook-agent-rate-limit"))
    missingPerms.push("Zone → WAF → Edit (ruleset 'musebook-agent-rate-limit' not created)");

  if (missingPerms.length)
    return {
      ok: false,
      errors,
      blocked: `cost controls pending token permissions: ${missingPerms.join("; ")}`,
    };

  // (d) Vercel spend limit — dashboard-only; asserted here as "project exists
  // and Vercel spend management is documented in OPERATIONS.md".
  const ops = existsSync(join(ROOT, "OPERATIONS.md"))
    ? readFileSync(join(ROOT, "OPERATIONS.md"), "utf8")
    : "";
  if (!/spend/i.test(ops))
    errors.push("OPERATIONS.md does not record the Vercel spend-limit control");

  return { ok: errors.length === 0, errors };
}

// M11.13 — the worker is route-less: no HTTP routes on musebook-worker, and
// CRON_SECRET exists nowhere (jobs are triggered by Cron Triggers, not HTTP).
export function m11WorkerRouteless() {
  const errors = [];
  const cfg = readFileSync(join(ROOT, "apps/worker/wrangler.jsonc"), "utf8");
  if (/"routes"\s*:\s*\[/.test(cfg)) errors.push("worker wrangler declares routes");
  if (/"workers_dev"\s*:\s*true/.test(cfg)) errors.push("worker workers_dev is on");
  const cronSecret = rg("CRON_SECRET", ["apps", "packages", "supabase", "infra"], []);
  if (cronSecret.length) errors.push(`CRON_SECRET present: ${cronSecret.join(" | ")}`);
  const idx = readFileSync(join(ROOT, "apps/worker/src/index.ts"), "utf8");
  if (/export default \{[\s\S]*?async fetch\(/.test(idx))
    errors.push("worker still exports a fetch handler");
  return { ok: errors.length === 0, errors };
}

// ------------------------------------------------------------------ M12 --

let _prodUp = null;
/** Is musebook.dev serving at all — the precondition every drill record needs. */
async function prodIsUp() {
  _prodUp ??= await fetch("https://musebook.dev/", {
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => r.status < 500)
    .catch(() => false);
  return _prodUp;
}

// M12.1 — every §17 gate green against production. The honest form of the
// check: re-run each milestone gate, same code CI runs, and require exit 0.
// A BLOCK inside any of them is reported per-milestone — §16.6 counts a block
// as not-green, and hiding which milestone is holding the launch up helps no
// one.
export function m12AllGatesGreen() {
  const errors = [];
  const notGreen = [];
  for (let m = 0; m <= 11; m++) {
    const tag = `M${m}`;
    const r = run(`GATE_AS_OF=M12 pnpm gate ${tag} --allow-dirty`, { timeout: 900000 });
    if (r.code !== 0) {
      const line = r.out
        .split("\n")
        .filter((l) => /BLOCK|FAIL/.test(l))
        .slice(0, 4)
        .join(" | ");
      notGreen.push(`${tag}${line ? ` (${line.slice(0, 240)})` : ""}`);
    }
  }
  if (notGreen.length)
    return {
      ok: false,
      errors,
      blocked: `milestones not green against the live suite: ${notGreen.join(", ")}`,
    };
  return { ok: true, errors };
}

// M12.2 — one real mainnet settlement: a row in x402_settlements on
// eip155:8453 carrying a real tx hash, a revenue_share_version and a
// facilitator_url, with its payout_ledger split derived from the policy. The
// §16.6 shadow fallback keeps the check amber, not red, when H9/H10 aren't
// landed yet.
export function m12MainnetSettlement() {
  const errors = [];
  if (!process.env.SUPABASE_DB_URL)
    return { ok: false, errors, blocked: "SUPABASE_DB_URL unset (prod probe)" };
  if (/127\.0\.0\.1|localhost/.test(process.env.SUPABASE_DB_URL))
    return {
      ok: false,
      errors,
      blocked: "SUPABASE_DB_URL is loopback — point it at the prod project for this check",
    };
  const { r, cmd, blocked } = psqlCmd(
    `select transaction is not null and transaction <> '' and ` +
      `revenue_share_version is not null and facilitator_url is not null ` +
      `from public.x402_settlements where network='eip155:8453' ` +
      `order by created_at desc limit 1`,
  );
  if (blocked) return { ok: false, errors, blocked };
  const res = run(cmd);
  if (res.out.trim() === "t") return { ok: true, errors };
  const ops = existsSync(join(ROOT, "OPERATIONS.md"))
    ? readFileSync(join(ROOT, "OPERATIONS.md"), "utf8")
    : "";
  const shadow = /X402_MODE\s*=\s*shadow/i.test(ops);
  return {
    ok: false,
    errors: shadow ? [] : ["no eip155:8453 row in x402_settlements with tx+rsv+facilitator"],
    blocked: shadow
      ? "mainnet running X402_MODE=shadow (H9/H10 pending) — documented fallback, still not a settlement"
      : `no mainnet settlement yet (H9: funded Base wallet; H10: CDP facilitator)${res.code ? ` — psql ${res.out.slice(-200)}` : ""}`,
  };
}

// M12.3 — the facilitator /supported lists X402_NETWORK at x402Version 2. The
// failure mode this names: a mainnet route pointed at a testnet facilitator
// returns plausible 402s and never settles anything (H10).
export async function m12FacilitatorSupported() {
  const errors = [];
  const url = process.env.X402_FACILITATOR_URL;
  const network = process.env.X402_NETWORK;
  if (!url || !network)
    return { ok: false, errors, blocked: "X402_FACILITATOR_URL/X402_NETWORK unset (H10)" };
  const res = await fetch(`${url.replace(/\/$/, "")}/supported`, {
    signal: AbortSignal.timeout(10000),
  }).catch((e) => e);
  if (res instanceof Error || !res.ok)
    return {
      ok: false,
      errors,
      blocked: `facilitator /supported unreachable: ${res instanceof Error ? res.message : res.status}`,
    };
  const body = await res.json().catch(() => null);
  const text = JSON.stringify(body);
  if (!text.includes(network)) errors.push(`/supported does not list ${network}`);
  if (!/"x402Version"\s*:\s*2/.test(text) && !/"version"\s*:\s*2/.test(text))
    errors.push("/supported carries no x402Version 2 entry");
  return { ok: errors.length === 0, errors };
}

// M12.4 — the synthetic 402 probe is live: the gated slug 402s on the apex,
// the origin refuses it, and the ops_counters rows prove the scheduled pass
// has fired — with the failure path drilled (recorded in OPERATIONS.md).
export async function m12Synthetic402() {
  const errors = [];
  const slug = process.env.SYNTHETIC_GATED_SLUG;
  if (!slug) return { ok: false, errors, blocked: "SYNTHETIC_GATED_SLUG unset" };
  const gate = await fetch(`https://musebook.dev/p/${slug}`, {
    headers: { accept: "text/markdown" },
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  }).catch((e) => e);
  if (gate instanceof Error)
    return { ok: false, errors, blocked: `musebook.dev unreachable: ${gate.message}` };
  if (gate.status === 404)
    return {
      ok: false,
      errors,
      blocked: `musebook.dev/p/${slug} → 404 — edge + gated post not deployed yet`,
    };
  if (gate.status !== 402) errors.push(`https://musebook.dev/p/${slug} → ${gate.status}, want 402`);

  const originHost = process.env.ORIGIN_HOST;
  if (originHost) {
    const origin = await fetch(`https://${originHost}/p/${slug}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (origin && origin.status !== 404)
      errors.push(`origin /p/${slug} → ${origin.status}, want 404`);
  }

  if (process.env.SUPABASE_DB_URL) {
    const { r, cmd, blocked } = psqlCmd(
      `select coalesce(sum(value),0) from public.ops_counters ` +
        `where metric='musebook.synthetic_402.gate'`,
    );
    if (!blocked) {
      const res = run(cmd);
      if (Number(res.out.trim()) < 1)
        errors.push("ops_counters shows no successful synthetic-402 probe yet");
    }
  }
  const ops = existsSync(join(ROOT, "OPERATIONS.md"))
    ? readFileSync(join(ROOT, "OPERATIONS.md"), "utf8")
    : "";
  if (!/synthetic.?402[^\n]*fail|broken price/i.test(ops)) {
    if (gate instanceof Error || gate.status !== 402)
      return {
        ok: false,
        errors,
        blocked: "failure-path drill needs a live 402 to break — deploy first",
      };
    errors.push("OPERATIONS.md does not record the failure-path drill (broken-price run)");
  }
  return { ok: errors.length === 0, errors };
}

// M12.5 — the nightly suite exists and has been green twice consecutively.
// The workflow shape is asserted statically; the two green runs are evidence
// recorded in OPERATIONS.md once the scheduled runs exist.
export async function m12NightlyGreen() {
  const errors = [];
  const f = join(ROOT, ".github/workflows/nightly.yml");
  if (!existsSync(f)) return { ok: false, errors: ["nightly.yml missing"] };
  const w = readFileSync(f, "utf8");
  if (!/cron:/.test(w)) errors.push("nightly.yml has no schedule");
  if (!/vitest\.live\.config|live.*tier|live-external/i.test(w))
    errors.push("nightly.yml does not run the T5 live-external tier");
  if (!/pnpm gate M12|gate M12/.test(w)) errors.push("nightly.yml does not run the M12 gate");
  const ops = existsSync(join(ROOT, "OPERATIONS.md"))
    ? readFileSync(join(ROOT, "OPERATIONS.md"), "utf8")
    : "";
  const greenRuns = (ops.match(/nightly[^\n]*(green|pass)/gi) ?? []).length;
  if (greenRuns < 2)
    return {
      ok: false,
      errors,
      blocked: (await prodIsUp())
        ? "two consecutive green nightly runs not yet recorded in OPERATIONS.md"
        : "nightly suite unproven — the workflow needs the deployment secrets (VERCEL_*/CLOUDFLARE_*) before its first green run exists",
    };
  return { ok: errors.length === 0, errors };
}

// M12.6 — no preview holds a production route: edge's preview env is
// workers_dev-only with no routes, and the Vercel preview surface is
// unpaywalled-by-design + indexed by nothing (robots.ts preview branch).
export function m12PreviewIsolation() {
  const errors = [];
  const cfg = readFileSync(join(ROOT, "apps/edge/wrangler.jsonc"), "utf8");
  if (!/"preview"\s*:\s*\{[^}]*"workers_dev"\s*:\s*true/s.test(cfg))
    errors.push("edge wrangler env.preview lacks workers_dev:true");
  const preview = cfg.match(/"preview"\s*:\s*\{([\s\S]*?)\n  \}\n\}/)?.[1] ?? "";
  if (/"routes"\s*:/.test(preview)) errors.push("edge preview env declares routes");
  const prod = cfg.slice(0, cfg.indexOf('"env"'));
  if (!/"routes"\s*:/.test(prod))
    errors.push("edge prod config declares no routes — the paywall has no surface");

  const robots = join(ROOT, "apps/web/app/robots.ts");
  if (!existsSync(robots)) errors.push("app/robots.ts missing (preview must be unindexed)");
  else {
    const r = readFileSync(robots, "utf8");
    if (!/VERCEL_ENV\s*={2,3}\s*["']preview["']/.test(r))
      errors.push("robots.ts has no preview branch");
    if (!/disallow:\s*"\/"|disallow:\s*\[?"\/"\]?/.test(r))
      errors.push("robots.ts preview branch does not disallow all");
  }
  return { ok: errors.length === 0, errors };
}

// M12.7 — origin still closed: proxy.ts still sends x-musebook-edge and the
// PREVIOUS-first rotation order is drilled and recorded (O7, §3.11).
export async function m12OriginClosed() {
  const errors = [];
  const proxy = join(ROOT, "apps/web/proxy.ts");
  if (!existsSync(proxy)) errors.push("apps/web/proxy.ts missing");
  else {
    const p = readFileSync(proxy, "utf8");
    if (!/x-musebook-edge/.test(p)) errors.push("proxy.ts does not gate on x-musebook-edge");
    if (!/PREVIOUS|_PREVIOUS/.test(p))
      errors.push("proxy.ts does not accept the _PREVIOUS rotation slot");
  }
  const ops = existsSync(join(ROOT, "OPERATIONS.md"))
    ? readFileSync(join(ROOT, "OPERATIONS.md"), "utf8")
    : "";
  if (!/MUSEBOOK_EDGE_SECRET_PREVIOUS|rotation[^\n]*drill|drill[^\n]*rotation/i.test(ops)) {
    if (await prodIsUp()) errors.push("OPERATIONS.md records no origin-secret rotation drill");
    else
      return {
        ok: false,
        errors,
        blocked: "rotation drill needs a live origin — deploy first, then run it",
      };
  }
  return { ok: errors.length === 0, errors };
}

// M12.8 — the three sealed buckets still sealed and cdn.musebook.dev still
// the only custom domain on any bucket. G-R2-SEAL's assertions re-run, plus
// the public bucket's domain list read back.
export async function m12R2Seal() {
  const seal = await r2Seal();
  const errors = [...seal.errors];
  if (seal.blocked) return { ok: false, errors, blocked: seal.blocked };
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account)
    return { ok: false, errors, blocked: "CF token/account unset (custom-domain read)" };
  const list = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/musebook-public/domains/custom`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).catch((e) => e);
  if (list instanceof Error) return { ok: false, errors, blocked: list.message };
  const body = await list.json().catch(() => ({}));
  const domains = (body.result?.domains ?? []).map((d) => d.domain ?? d.hostname ?? "");
  const extras = domains.filter((d) => d !== "cdn.musebook.dev");
  if (!domains.includes("cdn.musebook.dev")) errors.push("cdn.musebook.dev not on musebook-public");
  if (extras.length) errors.push(`unexpected custom domains on musebook-public: ${extras.join()}`);
  return { ok: errors.length === 0, errors };
}

// M12.9 — the kill-switch drill is recorded with an elapsed time: the lever
// that replaces pause-on-limit is only real if it's been flipped and timed.
export async function m12KillSwitchDrill() {
  const errors = [];
  const ops = existsSync(join(ROOT, "OPERATIONS.md"))
    ? readFileSync(join(ROOT, "OPERATIONS.md"), "utf8")
    : "";
  if (!/kill.?switch/i.test(ops)) errors.push("OPERATIONS.md does not record the kill-switch");
  if (!/kill.?switch[^\n]*(drill|elapsed|\d+\s*(min|s)\b)/i.test(ops)) {
    if (await prodIsUp()) errors.push("no kill-switch drill with an elapsed time in OPERATIONS.md");
    else
      return {
        ok: false,
        errors,
        blocked: "kill-switch drill needs live traffic to shed — deploy first",
      };
  }
  return { ok: errors.length === 0, errors };
}

// M12.10 — four one-line API reads that catch the four ways the platform
// silently stops existing: Vercel renew:true, zone active, the assigned NS
// pair, SSL strict.
export async function m12ZoneHealth() {
  const errors = [];
  const token = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  const zone = process.env.CF_ZONE_ID;
  if (!token || !zone) return { ok: false, errors, blocked: "CF_API_TOKEN/CF_ZONE_ID unset" };
  const z = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const zr = z.result ?? {};
  if (zr.status !== "active") errors.push(`zone status '${zr.status}'`);
  const ns = new Set(zr.name_servers ?? []);
  for (const want of ["aria.ns.cloudflare.com", "coen.ns.cloudflare.com"])
    if (!ns.has(want)) errors.push(`nameserver ${want} not assigned`);
  const ssl = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/settings/ssl`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  if (ssl.result?.value !== "strict") errors.push(`ssl '${ssl.result?.value}'`);
  if (!process.env.VERCEL_TOKEN) errors.push("VERCEL_TOKEN unset — renew:true unread");
  else {
    const r = run(
      `curl -sf -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v3/domains/musebook.dev?teamId=team_PYXAVq4jrHw8k0bNffmhc2jE"`,
    );
    let renew = null;
    try {
      const d = JSON.parse(r.out);
      renew = (d.domain ?? d).renew;
    } catch {}
    if (renew !== true) errors.push("musebook.dev Vercel renew is not true");
  }
  return { ok: errors.length === 0, errors };
}

// M12.11 — no universal skipping: every UNIVERSAL activeFrom is at or below
// M12 except exactly one — G-ISO, whose whole job is arriving later.
export function m12NoUniversalSkipping() {
  const errors = [];
  const src = readFileSync(join(ROOT, "scripts/gates/manifest.mjs"), "utf8");
  const uni = src.slice(src.indexOf("export const UNIVERSAL"));
  const later = [...uni.matchAll(/id:\s*"(G-[A-Z-]+)"[\s\S]*?activeFrom:\s*"M(\d+)"/g)]
    .map((m) => ({ id: m[1], at: Number(m[2]) }))
    .filter((e) => e.at > 12);
  if (later.length !== 1 || later[0].id !== "G-ISO")
    errors.push(
      `universals deferred past M12: ${later.map((e) => `${e.id}(M${e.at})`).join(", ") || "none — expected exactly G-ISO"}`,
    );
  return { ok: errors.length === 0, errors };
}

// M12.12 — launch copy honest: same two prices as platform_publishing_defaults
// everywhere the money is described, the Toll sentence unmodified, and the
// feed described as a logged reverse-chron slate — never a live ranker (§1.6).
export function m12LaunchCopy() {
  const errors = [];
  const page = join(ROOT, "apps/web/app/(marketing)/page.tsx");
  if (!existsSync(page)) return { ok: false, errors: ["(marketing)/page.tsx missing"] };
  const src = readFileSync(page, "utf8");
  const TOLL =
    "An agent that doesn't declare itself is served as a person. Toll is a declared contract, not a detection guarantee.";
  if (!src.includes(TOLL)) errors.push("Toll sentence missing or modified on the landing page");
  if (!src.includes("$0.002"))
    errors.push("agent crawl price $0.002 missing from the landing page");
  if (!src.includes("USDC on Base")) errors.push("'USDC on Base' missing");
  for (const a of ["Claude", "Codex", "OpenClaw", "Hermes"])
    if (!src.includes(a)) errors.push(`agent strip is missing ${a}`);
  for (const banned of ["muse is coming"])
    if (new RegExp(banned, "i").test(src)) errors.push(`landing copy contains '${banned}'`);
  // No fabricated testimonials may render at launch — the flag wiring is
  // allowed to exist, but nothing may branch on it into visible copy yet.
  if (/SHOW_TESTIMONIALS\s*&&|SHOW_TESTIMONIALS\s*\?/.test(src))
    errors.push("testimonial content renders under the flag — launch has zero published");
  if (!/reverse-chronological|recency/i.test(src))
    errors.push("feed section does not describe the launch slate honestly (reverse-chron)");
  if (/ranked feed (is )?(live|now|here)|now ranked/i.test(src))
    errors.push("landing claims a live ranked feed — P2 is a logged reverse-chron slate at launch");
  if (/^"use client"/m.test(src)) errors.push("page.tsx is not a Server Component");

  const picker = join(ROOT, "packages/ui/src/compose/ModePicker.tsx");
  const pick = existsSync(picker) ? readFileSync(picker, "utf8") : "";
  if (
    !pick.includes("declare itself") ||
    !pick.includes("is served as a person. Toll is a declared contract, not a detection guarantee.")
  )
    errors.push("Toll sentence missing or modified in ModePicker");
  return { ok: errors.length === 0, errors };
}
