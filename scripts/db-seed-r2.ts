// scripts/db-seed-r2.ts — seeds the four R2 seed objects asserted by
// fixtures/resources.ts (§17.3.2):
//
//   musebook-public : seed/poster.jpg        (poster)
//                     seed/clip/master.m3u8  (HLS clip)
//   musebook-paid   : seed/paid-image.jpg    (paid image)
//                     seed/clip/seg0.ts      (.ts segment)
//
// Keys are committed constants — idempotent `put`, never random. Run:
//   pnpm db:seed-r2            # remote R2 via CF_API_TOKEN
//   MUSEBOOK_SEED_R2_LOCAL=1 pnpm db:seed-r2   # Miniflare store
//   MUSEBOOK_SEED_R2_LOCAL=miniflare … same, explicit

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asset = (name: string) => path.join(root, "supabase/seed-assets/seed", name);

const OBJECTS: { bucket: string; key: string; file: string; type: string }[] = [
  {
    bucket: "musebook-public",
    key: "seed/poster.jpg",
    file: asset("poster.jpg"),
    type: "image/jpeg",
  },
  {
    bucket: "musebook-public",
    key: "seed/clip/master.m3u8",
    file: asset("master.m3u8"),
    type: "application/vnd.apple.mpegurl",
  },
  {
    bucket: "musebook-paid",
    key: "seed/paid-image.jpg",
    file: asset("paid-image.jpg"),
    type: "image/jpeg",
  },
  { bucket: "musebook-paid", key: "seed/clip/seg0.ts", file: asset("seg0.ts"), type: "video/mp2t" },
];

const local = !!process.env.MUSEBOOK_SEED_R2_LOCAL;
if (!local && !process.env.CF_API_TOKEN) {
  console.error(
    "FAIL CF_API_TOKEN is not set — remote R2 writes need it. " +
      "Set MUSEBOOK_SEED_R2_LOCAL=1 to seed the Miniflare store instead.",
  );
  process.exit(1);
}

for (const o of OBJECTS) {
  const args = [
    "wrangler",
    "r2",
    "object",
    "put",
    `${o.bucket}/${o.key}`,
    "--file",
    o.file,
    "--content-type",
    o.type,
    local ? "--local" : "--remote",
  ];
  const r = spawnSync("pnpm", ["exec", ...args], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`FAIL put ${o.bucket}/${o.key}`);
    process.exit(1);
  }
  console.log(`ok ${o.bucket}/${o.key}`);
}
console.log("db:seed-r2 PASS");
