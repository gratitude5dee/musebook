#!/usr/bin/env node
// packages/kernel/scripts/goldens-barrel.mjs — §17.4.
//
//   node scripts/goldens-barrel.mjs            -> regenerates test/golden/index.ts
//   node scripts/goldens-barrel.mjs --verify   -> diffs, prints OK, exits 1 on drift
//
// The barrel maps each fixture name to the exact contents of its .snap file as a
// string literal. The .snap files stay the reviewable artefact; the barrel is what
// both test runtimes import, because the workerd tier has no node:fs.
// Generated, never hand-edited, excluded from coverage.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GOLDEN_DIR = new URL("../test/golden/", import.meta.url).pathname;
const BARREL = join(GOLDEN_DIR, "index.ts");

const snaps = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".snap"))
  .sort();

const body =
  `// GENERATED FILE — regenerate with \`pnpm --filter @musebook/kernel goldens:barrel\`.\n` +
  `// Never hand-edit: G-GOLDEN diffs this against the .snap files and fails on drift.\n` +
  `export const GOLDEN: Record<string, string> = {\n` +
  snaps
    .map(
      (f) =>
        `  ${JSON.stringify(f.replace(/\.snap$/, ""))}: ${JSON.stringify(readFileSync(join(GOLDEN_DIR, f), "utf8"))},`,
    )
    .join("\n") +
  `\n};\n`;

const mode = process.argv[2];
if (mode === "--verify") {
  const committed = readFileSync(BARREL, "utf8");
  if (committed === body) {
    process.stdout.write(`OK ${snaps.length} fixtures in barrel\n`);
    process.exit(0);
  }
  process.stdout.write(
    `BARREL DRIFT: test/golden/index.ts does not match the ${snaps.length} .snap files\n`,
  );
  process.exit(1);
}
if (snaps.length !== 24) {
  process.stdout.write(`expected 24 .snap files, found ${snaps.length}\n`);
  process.exit(1);
}
writeFileSync(BARREL, body);
process.stdout.write(`wrote ${BARREL} (${snaps.length} fixtures)\n`);
