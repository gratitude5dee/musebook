#!/usr/bin/env node
// scripts/gate.mjs — the gate runner (§17.12). Usage:
//   pnpm gate M<n>            — the milestone's numbered list + the universal list
//   pnpm gate --check <name>  — ONE named check, outside any gate (no verdict, no record)
//   pnpm gate --universal     — the universal list only, activeFrom vs branch milestone
//
// §17.12.2's four properties:
//   1. refuses a dirty tree unless --allow-dirty (stamps "dirty": true into JSON)
//   2. no --only on a milestone gate; named checks by name only
//   3. never mutates the repository
//   4. a universal check is skipped only before its activeFrom — and the skip is
//      printed AND recorded, never folded into a pass.
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATES, MILESTONE_TITLES, UNIVERSAL } from "./gates/manifest.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const CI = !!process.env.CI;
const args = process.argv.slice(2);

const out = (s = "") => process.stdout.write(s + "\n");
const err = (s = "") => process.stderr.write(s + "\n");

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function trySh(cmd) {
  // vitest/playwright can hang at teardown after printing results (workerd
  // keeps outbound sockets open and grandchildren keep the stdio pipe alive,
  // so a plain execSync timeout never returns). Run them under setsid writing
  // to a file and TERM/KILL the whole process group at the bound; when the
  // kill lands after a complete `Test Files … passed` printout, the suite
  // passed — judge by the output, not the 124.
  if (/vitest|playwright/.test(cmd)) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const file = `/tmp/gate-sh-${id}.out`;
    const supervisor = `/tmp/gate-sh-${id}.sh`;
    const secs = 900;
    writeFileSync(
      supervisor,
      `#!/usr/bin/env bash
setsid bash -c "${cmd.replace(/"/g, '\\"')} > ${file} 2>&1" &
pid=$!
for i in $(seq 1 ${secs}); do
  if ! kill -0 $pid 2>/dev/null; then wait $pid; exit 0; fi
  sleep 1
done
kill -TERM -- -$pid 2>/dev/null
sleep 5
kill -KILL -- -$pid 2>/dev/null
exit 124
`,
    );
    try {
      execSync(`bash ${supervisor}`, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: (secs + 30) * 1000,
      });
    } catch (e) {
      const out = existsSync(file) ? readFileSync(file, "utf8") : "";
      const anyFail = /FAIL\s|✗|×|\b\d+ failed\b/.test(out);
      const suiteDone = /Test Files\s+.*?\d+\s+passed/.test(out);
      return { code: anyFail || !suiteDone ? (e.status ?? 1) : 0, out };
    }
    const out = existsSync(file) ? readFileSync(file, "utf8") : "";
    return { code: 0, out };
  }
  try {
    return { code: 0, out: sh(cmd) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const git = (c) => trySh(`git ${c}`);
const sha = () => git("rev-parse --short=8 HEAD").out || "unknown";
const branch = () => git("rev-parse --abbrev-ref HEAD").out || "unknown";
const dirty = () => git("status --porcelain").out.length > 0;

function pkgVersion(name) {
  const r = trySh(
    `pnpm exec node -e "console.log(require('${name}/package.json').version)" 2>/dev/null`,
  );
  if (r.code === 0 && /^\d+\.\d+\.\d+/.test(r.out)) return r.out.match(/\d+\.\d+\.\d+/)[0];
  const l = trySh(`pnpm ls ${name} --depth 0 --json 2>/dev/null`);
  const m = l.out.match(/"version":\s*"([^"]+)"/);
  return m ? m[1] : "?";
}

function milestoneFromBranch() {
  const b = branch();
  const m = b.match(/^m(\d+)-/);
  return m ? `M${m[1]}` : null;
}

// ---------------------------------------------------------------------------

function parseMilestone(s) {
  const m = /^M(\d+)$/i.exec(s ?? "");
  return m ? `M${m[1]}` : null;
}

async function runCheck(check, milestone, record, selfTest = false) {
  const started = Date.now();
  if (selfTest) {
    // Self-test exercises ordering, skip evaluation, the verdict line and the
    // JSON write — without executing the checks (which would recurse).
    record.push({
      id: check.id,
      status: "pass",
      duration_s: 0,
      exit_code: 0,
      output: "self-test: not executed",
    });
    return { status: "pass", duration: 0, output: "", blocked: null };
  }
  let status,
    output = "",
    exitCode = 0,
    blocked = null;

  if (check.kind === "sh") {
    const r = trySh(check.run);
    exitCode = r.code;
    output = r.out;
    status = r.code === 0 ? "pass" : "fail";
  } else if (check.kind === "fn") {
    try {
      const res = await check.run();
      if (res?.blocked) {
        status = "block";
        blocked = res.blocked;
        output = `BLOCK ${check.id}  ${check.desc} — ${res.blocked}`;
      } else {
        status = res.ok ? "pass" : "fail";
        output = (res.errors ?? []).join("\n");
        exitCode = res.ok ? 0 : 1;
      }
    } catch (e) {
      status = "fail";
      output = String(e?.stack ?? e);
      exitCode = 1;
    }
  } else if (check.kind === "sql") {
    const docker = trySh(
      "docker ps --format '{{.Names}}' --filter name=supabase_db 2>/dev/null | head -1",
    ).out.trim();
    const localUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    const url = process.env.SUPABASE_DB_URL ?? (docker ? localUrl : "");
    const hostPsql = trySh("command -v psql >/dev/null 2>&1").code === 0;
    if (!url) {
      status = "block";
      blocked = "SUPABASE_DB_URL unset and no local stack";
    } else if (!hostPsql && docker && /127\.0\.0\.1|localhost/.test(url)) {
      const r = trySh(`docker exec ${docker} psql -U postgres -Atc ${JSON.stringify(check.sql)}`);
      status = r.out.trim() === check.expect ? "pass" : "fail";
      output = r.out;
      exitCode = status === "pass" ? 0 : 1;
    } else if (!hostPsql) {
      status = "block";
      blocked = "no psql binary and no supabase_db container";
    } else {
      const r = trySh(`psql ${JSON.stringify(url)} -Atc ${JSON.stringify(check.sql)}`);
      status = r.out.trim() === check.expect ? "pass" : "fail";
      output = r.out;
      exitCode = status === "pass" ? 0 : 1;
    }
  } else {
    status = "fail";
    output = `unimplemented check (kind ${check.kind})`;
    exitCode = 1;
  }

  const duration = (Date.now() - started) / 1000;
  record.push({
    id: check.id,
    status,
    duration_s: Number(duration.toFixed(2)),
    exit_code: exitCode,
    output: String(output).slice(0, 4096),
    ...(check.prereq ? { prereq: check.prereq } : {}),
  });
  return { status, duration, output, blocked };
}

function printLine(status, check, detail = "") {
  const pad1 = check.id.padEnd(13);
  const pad2 = (check.desc ?? "").padEnd(56);
  out(`${status.padEnd(5)} ${pad1} ${pad2}${detail}`);
}

// --- mode 1: pnpm gate --check <name> --------------------------------------
async function runNamed(name) {
  const all = [...UNIVERSAL, ...Object.values(GATES).flat()];
  const check = all.find((c) => c.name === name);
  if (!check) {
    err(
      `no check named '${name}'. Named checks: ${all
        .filter((c) => c.name)
        .map((c) => c.name)
        .join(", ")}`,
    );
    process.exit(2);
  }
  const record = [];
  const { status, output, blocked } = await runCheck(check, null, record);
  if (status === "pass") out(`PASS  ${check.id}  ${check.desc}`);
  else if (status === "block") out(`BLOCK ${check.id}  ${check.desc} — ${blocked}`);
  else {
    for (const line of String(output).split("\n").filter(Boolean)) err(`::error::${line}`);
  }
  process.exit(status === "pass" ? 0 : 1);
}

// --- modes 2-3: milestone gate / --universal --------------------------------
async function runGate(milestone, universalOnly, selfTest = false) {
  const dirtyTree = dirty();
  if (dirtyTree && !args.includes("--allow-dirty") && !selfTest) {
    err("working tree is dirty — commit or pass --allow-dirty (§17.12.2 property 1)");
    process.exit(2);
  }

  const title = MILESTONE_TITLES[milestone] ?? "";
  const list = universalOnly ? [] : (GATES[milestone] ?? []);
  const mNum = parseInt(milestone.slice(1), 10);
  // Checks that scope themselves to files-as-of-a-milestone read this.
  process.env.GATE_MILESTONE = milestone;
  // Nested gates inside M12.1 pass GATE_AS_OF so a check superseded AFTER its
  // own milestone still skips on a full-tree re-run (§16.6's "green against
  // production" is evaluated as-of the launch milestone, not the check's own).
  const asOfNum = parseInt((process.env.GATE_AS_OF ?? milestone).slice(1), 10);

  out(`GATE ${milestone} — ${title}`);
  out(
    `commit  ${sha()}  branch ${branch()}  node ${process.version}  pnpm ${trySh("pnpm --version").out || "?"}`,
  );
  out(
    `tools   vitest ${pkgVersion("vitest")}  @cloudflare/vitest-plugin ${pkgVersion("@cloudflare/vitest-plugin")}  wrangler ${pkgVersion("wrangler")}  typescript ${pkgVersion("typescript")}`,
  );
  const dbUrl = process.env.SUPABASE_DB_URL ?? "postgresql://127.0.0.1:54322/postgres (unresolved)";
  let seedHashShort = "none";
  if (existsSync(join(ROOT, "supabase/SEED_HASH")))
    seedHashShort = readFileSync(join(ROOT, "supabase/SEED_HASH"), "utf8").trim().slice(0, 16);
  out(`db      ${dbUrl.replace(/:[^:@]+@/, "://***@")}   seed ${seedHashShort}`);
  out(`started ${new Date().toISOString()}`);
  out("");

  // A prior gate's `supabase db reset` restarts postgres asynchronously — a
  // fresh run can land while the DB is still being recreated. Wait until the
  // seed is actually replayed, not just until the port accepts.
  {
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      const probe = trySh(
        `docker exec $(docker ps -q --filter name=supabase_db | head -1) ` +
          `psql -U postgres -d postgres -Atc "select count(*) from public.posts"`,
      );
      ready = probe.code === 0 && Number(probe.out.trim()) >= 24;
      if (!ready) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) {
      err("gate: supabase local DB not replayed after 120s");
      process.exit(2);
    }
    // The migration ships no worker credential (§4.14): the wrangler dev
    // localConnectionString authenticates as musebook_worker, so a reset
    // leaves it unable to log in until the dev password is re-altered.
    trySh(
      `docker exec $(docker ps -q --filter name=supabase_db | head -1) ` +
        `psql -U postgres -d postgres -c "alter role musebook_worker password 'postgres'"`,
    );
  }

  const record = [];
  const failures = [];
  const blockedOn = new Set();
  let passed = 0;
  let skipped = 0;

  const ordered = [...list, ...UNIVERSAL];
  for (const check of ordered) {
    const active = mNum >= parseInt(check.activeFrom?.slice(1) ?? milestone.slice(1), 10);
    if (!active) {
      printLine("SKIP", check, `(activeFrom ${check.activeFrom})`);
      record.push({ id: check.id, status: "skip", activeFrom: check.activeFrom });
      skipped++;
      continue;
    }
    if (check.supersededBy && asOfNum >= parseInt(check.supersededBy.slice(1), 10)) {
      printLine("SKIP", check, `(superseded at ${check.supersededBy})`);
      record.push({ id: check.id, status: "skip", supersededBy: check.supersededBy });
      skipped++;
      continue;
    }
    const { status, duration, output, blocked } = await runCheck(
      check,
      milestone,
      record,
      selfTest,
    );
    const detail =
      status === "pass"
        ? `${duration.toFixed(1)}s`
        : status === "block"
          ? `— ${blocked}`
          : `${duration.toFixed(1)}s`;
    printLine(status.toUpperCase(), check, detail);
    if (status === "pass") passed++;
    else {
      failures.push(check.id);
      if (blocked) {
        const p = blocked.match(/H\d+/);
        if (p) blockedOn.add(p[0]);
        else blockedOn.add("credentials");
      }
      const tail = String(output).trim().split("\n").slice(-8);
      for (const line of tail) out(`      ${line}`);
    }
  }

  const green = failures.length === 0;
  out("");
  const skipClause = skipped ? ` — ${skipped} skipped (activeFrom)` : "";
  if (green) {
    out(
      `GATE ${milestone}: GREEN — ${passed} of ${ordered.length - skipped} checks passed${skipClause} — commit ${sha()} — ${new Date().toISOString()}`,
    );
  } else {
    const blockNote = blockedOn.size
      ? ` blocked on prerequisites ${[...blockedOn].join(", ")}`
      : "";
    out(
      `GATE ${milestone}: RED — ${failures.length} of ${ordered.length - skipped} checks failed (${failures.join(", ")})${skipClause}${blockNote}`,
    );
  }

  mkdirSync(join(ROOT, ".gate"), { recursive: true });
  const report = {
    milestone,
    commit: sha(),
    branch: branch(),
    dirty: dirtyTree || undefined,
    started: record[0] ? new Date().toISOString() : undefined,
    finished: new Date().toISOString(),
    seed_hash: seedHashShort,
    versions: {
      node: process.version,
      pnpm: trySh("pnpm --version").out || null,
      next: pkgVersion("next"),
      typescript: pkgVersion("typescript"),
      vitest: pkgVersion("vitest"),
      wrangler: pkgVersion("wrangler"),
      "@cloudflare/vitest-plugin": pkgVersion("@cloudflare/vitest-plugin"),
      supabase_cli: trySh("supabase --version").out || null,
    },
    checks: record,
  };
  writeFileSync(join(ROOT, `.gate/${milestone}.json`), JSON.stringify(report, null, 2) + "\n");
  out(`report  .gate/${milestone}.json`);
  process.exit(green ? 0 : 1);
}

// --- dispatch ----------------------------------------------------------------
if (args[0] === "--check") {
  await runNamed(args[1]);
} else if (args[0] === "--universal") {
  const milestone = args.includes("--milestone")
    ? parseMilestone(args[args.indexOf("--milestone") + 1])
    : (milestoneFromBranch() ?? "M0");
  await runGate(milestone, true);
} else {
  const milestone = parseMilestone(args[0]) ?? milestoneFromBranch();
  if (!milestone) {
    err(
      "usage: pnpm gate M<n> | pnpm gate --check <name> | pnpm gate --universal [--milestone M<n>]",
    );
    process.exit(2);
  }
  await runGate(milestone, false, args.includes("--self-test"));
}
