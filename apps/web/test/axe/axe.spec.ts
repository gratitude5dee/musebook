// G-AXE — §14.5.4's audited routes in both themes, zero serious/critical.
// Every request goes through the Worker (baseURL is the wrangler dev port).
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ROUTES = [
  "/",
  "/feed",
  "/reels",
  "/p/seed-article-free",
  "/p/seed-article-x402",
  "/compose",
  "/studio",
  "/agents",
] as const;

for (const route of ROUTES) {
  for (const theme of ["light", "dark"] as const) {
    test(`axe ${route} [${theme}]`, async ({ page }) => {
      await page.addInitScript((t: string) => {
        try {
          window.localStorage.setItem("theme", t);
        } catch {
          /* ignore */
        }
      }, theme);
      const res = await page.goto(route, { waitUntil: "load" });
      expect(res?.status(), `GET ${route}`).toBeLessThan(500);
      await page.waitForTimeout(400);
      const results = await new AxeBuilder({ page }).analyze();
      const bad = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(
        bad.map((v) => `${v.id}(${v.nodes.length})`),
        `${route} ${theme}: serious/critical axe violations`,
      ).toEqual([]);
    });
  }
}
