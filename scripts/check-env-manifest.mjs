#!/usr/bin/env node
// scripts/check-env-manifest.mjs — gate check G-ENV (§3.8), four assertions in
// order: completeness in both runtimes, no drift in the generated files,
// scope honesty per Worker (a secret committed as a var fails here), and
// build-cache honesty against turbo.json.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BINDINGS, GROUPS, IGNORED, WORKER_CONFIG } from "./env-manifest.mjs";
import { devVarsExample, envExample } from "./gen-env-example.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const errors = [];

function rg(args) {
  try {
    const out = execFileSync("rg", args, { cwd: ROOT, encoding: "utf8" });
    return out.trim().length ? out.trim().split("\n") : [];
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

// JSONC reader (comments + trailing commas).
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
  return JSON.parse(out.join("").replace(/,(\s*[}\]])/g, "$1"));
}

const manifest = new Map();
for (const g of GROUPS) for (const v of g.vars) manifest.set(v.name, v);

// --- assertion 1: completeness ----------------------------------------------
const known = new Set([...manifest.keys(), ...BINDINGS, ...IGNORED]);

// Vercel side: every process.env.NAME under apps/web and packages.
for (const h of rg([
  "-o",
  "--no-heading",
  "--line-number",
  String.raw`process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[["']([A-Z][A-Z0-9_]+)["']\]`,
  "apps/web",
  "packages",
])) {
  const m =
    h.match(/process\.env\.([A-Z][A-Z0-9_]+)/) ?? h.match(/process\.env\["([A-Z][A-Z0-9_]+)"\]/);
  const name = m?.[1];
  if (name && !known.has(name)) errors.push(`undocumented env read ${name}: ${h}`);
}

// Worker side: every env.NAME read under the three Worker's src/.
for (const h of rg([
  "-o",
  "--no-heading",
  "--line-number",
  String.raw`\benv\.([A-Z][A-Z0-9_]+)`,
  "apps/edge/src",
  "apps/mcp/src",
  "apps/worker/src",
])) {
  const name = h.match(/env\.([A-Z][A-Z0-9_]+)/)?.[1];
  if (name && !known.has(name)) errors.push(`undocumented Worker env read ${name}: ${h}`);
}

// --- assertion 2: no drift ---------------------------------------------------
for (const [file, rendered] of [
  [".env.example", envExample],
  [".dev.vars.example", devVarsExample],
]) {
  const committed = existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), "utf8") : null;
  if (committed !== rendered + "\n")
    errors.push(`${file} is stale or missing — regenerate with \`pnpm env:example\` and commit`);
}

// --- assertion 3: scope honesty ----------------------------------------------
const varsBlock = {};
for (const [scope, cfg] of Object.entries(WORKER_CONFIG)) {
  const c = readJsonc(join(ROOT, cfg));
  varsBlock[scope] = { file: cfg, names: new Set(Object.keys(c.vars ?? {})), all: c };
}

for (const v of manifest.values()) {
  if (v.kind === "var") {
    for (const scope of v.scope.filter((s) => WORKER_CONFIG[s])) {
      if (!varsBlock[scope].names.has(v.name))
        errors.push(
          `${v.name}: kind "var" with scope ${scope} must appear in ${WORKER_CONFIG[scope]}'s vars block`,
        );
    }
  }
  if (v.kind === "secret") {
    for (const cfg of Object.values(WORKER_CONFIG)) {
      const text = readFileSync(join(ROOT, cfg), "utf8");
      // a name in a comment is fine; in a key or value is not
      const uncommented = text
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
      if (uncommented.includes(`"${v.name}"`) || new RegExp(`${v.name}\\s*[=:]`).test(uncommented))
        errors.push(`${v.name}: kind "secret" must appear in NO wrangler.jsonc — found in ${cfg}`);
    }
  }
}
// reverse direction: every key in a vars block is a manifest var with that scope
for (const [scope, block] of Object.entries(varsBlock)) {
  for (const name of block.names) {
    const v = manifest.get(name);
    if (!v) errors.push(`${block.file}: vars.${name} is not in the §3.7 manifest`);
    else if (v.kind === "secret")
      errors.push(
        `${block.file}: vars.${name} is a SECRET in the manifest — secrets never live in wrangler.jsonc`,
      );
    else if (!v.scope.includes(scope))
      errors.push(`${block.file}: vars.${name} is not scoped to ${scope} in the manifest`);
  }
}

// --- assertion 4: build-cache honesty -----------------------------------------
const turbo = JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8"));
const turboEnv = new Set(turbo.tasks?.build?.env ?? []);
for (const v of manifest.values()) {
  if (v.kind === "public" && !turboEnv.has(v.name))
    errors.push(`${v.name}: kind "public" must appear in turbo.json tasks.build.env`);
  if (v.kind === "var" && turboEnv.has(v.name))
    errors.push(
      `${v.name}: a Worker-scoped var must NOT appear in turbo.json tasks.build.env (§3.2)`,
    );
}
for (const name of turboEnv) {
  const v = manifest.get(name);
  if (v && v.kind !== "public")
    errors.push(`turbo.json tasks.build.env carries non-public ${name}`);
  if (!v) errors.push(`turbo.json tasks.build.env carries ${name}, which is not in the manifest`);
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(`G-ENV ok: ${manifest.size} manifest names, both runtimes, generated files in sync`);
