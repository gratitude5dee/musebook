// apps/web/scripts/check-legal-review.mjs — §15.9's release brake. Any legal
// MDX still carrying the DRAFT marker fails the build when
// VERCEL_ENV === 'production'. Preview/dev builds warn and continue (the
// banner component renders the notice instead). Item 1 on §15.27's launch
// checklist is a human removing every marker.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "DRAFT — NOT LEGALLY REVIEWED";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "content", "legal");

const dirty = readdirSync(dir)
  .filter((f) => f.endsWith(".mdx"))
  .filter((f) => readFileSync(path.join(dir, f), "utf8").includes(MARKER));

if (dirty.length === 0) {
  console.log("check-legal-review: no unreviewed legal documents");
  process.exit(0);
}
if (process.env.VERCEL_ENV === "production" || process.env.LEGAL_REVIEW_STRICT === "1") {
  console.error(
    `check-legal-review: production build blocked — ${dirty.length} legal document(s) ` +
      `still carry "${MARKER}": ${dirty.join(", ")}. §15.27 item 1 requires counsel review.`,
  );
  process.exit(1);
}
console.warn(
  `check-legal-review: ${dirty.length} DRAFT legal document(s) — preview/dev build continues`,
);
