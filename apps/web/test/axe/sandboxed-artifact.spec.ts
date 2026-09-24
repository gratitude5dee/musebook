// apps/web/test/axe/sandboxed-artifact.spec.ts — M16 gate 6: from INSIDE the
// sandboxed frame, document.cookie is empty and cross-origin reads fail.
// The sandboxed document runs an opaque origin (no allow-same-origin), so
// cookies, storage and the parent DOM are unreachable by construction.
import { expect, test } from "@playwright/test";
import { EDGE_ORIGIN } from "./playwright.config";

test.describe("sandboxed artifact frame (M16.6)", () => {
  test("a frame without allow-same-origin gets an opaque origin", async ({ page }) => {
    // The sandboxed child points at the real edge worker: same-site but a
    // different host — exactly the artifacts.musebook.dev shape §2.8 draws.
    await page.setContent(
      `<html><body>` +
        `<iframe sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer" ` +
        `src="${EDGE_ORIGIN}/a/00000000-0000-4000-8000-000000000000/0123456789abcdef/index.html"></iframe>` +
        `</body></html>`,
    );
    const frame = page.frames().find((f) => f.url() !== "about:blank");
    expect(frame, "artifact frame loaded").toBeDefined();

    // Opaque origin ⇒ no cookie jar at all, not merely no __Host- cookie.
    const cookie = await frame!.evaluate(() => document.cookie);
    expect(cookie).toBe("");

    // Cross-origin reads into the parent fail — the embedder is untouchable.
    const parentRead = await frame!.evaluate(() => {
      try {
        return { ok: true as const, title: parent.document.title };
      } catch {
        return { ok: false as const };
      }
    });
    expect(parentRead.ok).toBe(false);

    // Storage APIs are likewise absent on an opaque origin.
    const storage = await frame!.evaluate(() => {
      try {
        localStorage.setItem("x", "1");
        return "available";
      } catch {
        return "blocked";
      }
    });
    expect(storage).toBe("blocked");
  });
});
