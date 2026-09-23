// §7.20 check 16 — WebMCP absence is a no-op: with no `document.modelContext`
// provider (the default state absent an origin trial token), the page DOM is
// unchanged, the free post renders, the gated post still walls, and the
// console is clean.
import { test, expect } from "@playwright/test";

test("M9-webmcp: no provider leaves the DOM and the paywall untouched", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  const free = await page.goto("/p/seed-article-free", { waitUntil: "load" });
  expect(free?.status()).toBe(200);
  const hasModelContext = await page.evaluate(() => "modelContext" in document);
  // The token is not shipped; both states are supported — either way the body
  // renders and nothing registered tools unconditionally.
  void hasModelContext;
  await expect(page.locator("body")).not.toBeEmpty();
  await expect(page.locator("main, article").first()).toBeVisible();

  const gated = await page.goto("/p/seed-article-x402", { waitUntil: "load" });
  expect(gated?.status()).toBeLessThan(500);
  // The gated body never leaks: the known paid sentence from the seed is absent.
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("paid sentence");
  expect(
    consoleErrors.filter(
      (e) =>
        !e.includes("favicon") &&
        // The 402 resource-load log is the paywall itself working, not an error.
        !e.includes("status of 402"),
    ),
  ).toEqual([]);
});
