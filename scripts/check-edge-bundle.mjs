// scripts/check-edge-bundle.mjs — gate check `edge-bundle` (§3.4, verbatim).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "apps/edge/.wrangler/dry";
// Substrings that must never appear in the edge Worker's built output.
// Each is a CF-SPINE §6 constraint, not a preference.
const FORBIDDEN = [
  ["viem", "EVM signature recovery at the edge — settlement is the facilitator's job"],
  ["node:fs", "@x402/evm batch-settlement file-storage leaked into the bundle"],
  ["node:path", "same"],
  ["@x402/paywall", "browser bundle: React 19 + wagmi + WalletConnect + Solana + Algorand"],
  ["@modelcontextprotocol", "the MCP SDK belongs in apps/mcp (second zod, 1s startup budget)"],
];

const files = readdirSync(DIR, { recursive: true }).filter(
  (f) => typeof f === "string" && f.endsWith(".js"),
);
if (files.length === 0) throw new Error(`${DIR} is empty — run \`pnpm cf:dry\` first.`);

let failed = false;
for (const file of files) {
  const text = readFileSync(join(DIR, file), "utf8");
  for (const [needle, why] of FORBIDDEN) {
    if (text.includes(needle)) {
      console.error(`edge-bundle: ${file} contains "${needle}" — ${why}`);
      failed = true;
    }
  }
}
// Startup budget is the limit Musebook is most likely to hit: the docs name
// "generating or consuming a large schema at the top level" as the common cause,
// and error 10021 is a DEPLOY failure, not a runtime one. 64 MiB is the hard cap.
const bytes = files.reduce((n, f) => n + readFileSync(join(DIR, f)).byteLength, 0);
console.log(`edge-bundle: ${files.length} file(s), ${(bytes / 1e6).toFixed(2)} MB uncompressed`);
if (bytes > 8_000_000) {
  console.error(
    "edge-bundle: over the 8 MB advisory budget (hard cap is 64 MiB). Investigate before deploying.",
  );
  failed = true;
}
process.exit(failed ? 1 : 0);
