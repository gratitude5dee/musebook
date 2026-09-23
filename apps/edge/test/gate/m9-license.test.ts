// apps/edge/test/gate/m9-license.test.ts — §7.20 check 21: the license is
// stored, not derived. train_ai = true on an x402_always post must surface on
// the wire as `Content-Usage: … train-ai=y` for a human fetch — whatever the
// access verdict, the header reflects the row, never a guess.
import { SELF } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { db, SLUG } from "./helpers.js";

const PAID_POST = "44444444-4444-4444-8444-000000000006"; // seed-article-x402

beforeAll(async () => {
  await db(`update public.posts set train_ai = true where id = $1`, [PAID_POST]);
});

afterAll(async () => {
  await db(`update public.posts set train_ai = false where id = $1`, [PAID_POST]);
});

describe("M9-license — Content-Usage carries the stored row", () => {
  it("GET /p/seed-article-x402.md as a human emits train-ai=y", async () => {
    const res = await SELF.fetch(
      new Request(`https://musebook.dev/p/${SLUG.gated}.md`, {
        headers: { "user-agent": "Mozilla/5.0 (gate human)" },
      }),
    );
    const usage = res.headers.get("content-usage") ?? "";
    expect(usage).toContain("train-ai=y");
    expect(usage).toContain("ai-use=");
    expect(usage).toContain("search=");
  });
});
