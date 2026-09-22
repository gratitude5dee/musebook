// §14 row 3 — the gated body is absent from what an unpaid reader receives,
// asserted with JavaScript disabled, against the Worker (not Vercel).
import { test, expect } from "@playwright/test";

const PAID_BODY_MARKER = "MUSEBOOK_PAID_BODY_MARKER_7f3a";

test.use({ javaScriptEnabled: false });

test("unpaid reader receives no gated body bytes", async ({ page }) => {
  // Anonymous, no session cookie, no payment — the default actor.
  const res = await page.goto("/p/seed-article-x402");
  expect(res?.status()).toBeLessThan(500);
  const html = await page.content();
  expect(html).not.toContain(PAID_BODY_MARKER);
  // The post page must still render its non-gated twin (title is public).
  expect(html).toContain("Seed Article (X402)");
});
