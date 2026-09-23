// apps/edge/test/gate/m9-robots.test.ts — §7.20 check 14: robots.txt emits the
// AIPREF Content-Usage declarations (body literals are the spec — the file IS
// the declaration carrier for crawlers), and the /p/ defaults are restrictive.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("§7.20 check 14 — robots.txt emits Content-Usage", () => {
  it("GET /robots.txt carries the per-surface usage declarations", async () => {
    const res = await SELF.fetch("https://musebook.dev/robots.txt", {
      headers: { "user-agent": "Mozilla/5.0 (test)" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Content-Usage: /p/ train-ai=n");
    expect(body).toContain("Content-Usage: /p/ ai-use=n");
    expect(body).toContain("Content-Usage: train-ai=n");
  });
});
