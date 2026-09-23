// packages/classify/test/no-private-state.test.ts — the privacy contract lives
// in SQL, so the test asserts the migration's predicates directly. A state
// builder that ever returned draft or deleted bodies would leak them to a
// third-party classifier; the predicate text is the whole boundary.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION = fileURLToPath(
  new URL("../../../supabase/migrations/20261103090000_classification_battery.sql", import.meta.url),
);

const sql = readFileSync(MIGRATION, "utf8");

describe("classification_state never exposes private state (§8.7)", () => {
  it("filters to visible post statuses only", () => {
    expect(sql).toMatch(/status in \('published'\s*,\s*'scheduled'\s*,\s*'unlisted'\)/i);
  });

  it("excludes deleted posts", () => {
    expect(sql).toMatch(/deleted_at is null/i);
  });

  it("bounds the body inside SQL before any TS sees it", () => {
    expect(sql).toMatch(/left\(\s*[a-z_.]*canonical_markdown\s*,\s*12000\s*\)/i);
  });
});
