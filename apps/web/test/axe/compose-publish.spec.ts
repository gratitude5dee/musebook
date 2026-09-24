// M7 gate 1 — §1.7 item 2 end to end: a human signs in (seed session), composes
// three posts across the three publishing modes — the Toll post carries a real
// media upload through the presigned-PUT path — publishes, and reads each post
// back at /p/{slug} through the Worker.
import { test, expect, type Page } from "@playwright/test";
import { EDGE_ORIGIN } from "./playwright.config";

const uniq = Math.random().toString(36).slice(2, 10);

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: "__Host-mb_session", value: "musebook-seed-session-token-0001", url: EDGE_ORIGIN },
  ]);
});

async function composeAndPublish(
  page: Page,
  opts: { mode: "Open" | "Toll" | "Gated"; priceUsd: string | null; kind: string; media: boolean },
) {
  const marker = `e2e-${uniq}-${opts.mode}`;
  await page.goto("/compose");
  const body = page.getByLabel("Post body");
  await body.click();
  await body.pressSequentially(`# ${marker}\n\nBody for ${opts.mode}.\n`, { delay: 8 });

  // Mode before media: the upload's target bucket follows the picker's access
  // (open → r2_public/cdn., paid → r2_paid/media.), so choose it first.
  if (opts.media) {
    await page.getByLabel("Post kind").selectOption("video");
  }
  if (opts.mode !== "Open") {
    await page.locator('button[aria-haspopup="dialog"]').first().click();
    await page.locator('[role="radio"]', { hasText: opts.mode }).click();
    if (opts.priceUsd !== null) {
      await page.getByLabel(`${opts.mode} price in USD`).fill(opts.priceUsd);
    }
    await page.keyboard.press("Escape");
  }

  if (opts.media) {
    await page
      .getByLabel("Upload media")
      .setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(4096, 7) });
    // The presigned PUT round-trip completes when the final, content-addressed
    // URL lands in the editor as markdown.
    await expect(body).toHaveValue(/https:\/\/media\.musebook\.dev\//, { timeout: 60_000 });
    await expect(body).toHaveValue(/\[clip\.mp4\]/);
  }

  // Autosave (3 s debounce) mints the draft; the slug appears in the footer.
  await expect(page.locator("span.font-mono", { hasText: "/p/" })).toBeVisible({
    timeout: 30_000,
  });

  const slugText = await page.locator("span.font-mono", { hasText: "/p/" }).textContent();
  const slug = /\/p\/([a-z0-9-]+)/.exec(slugText ?? "")?.[1];
  expect(slug, `slug for ${opts.mode}`).toBeTruthy();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("button", { name: "Published" })).toBeVisible({ timeout: 30_000 });
  return { slug: slug!, marker };
}

test("M7.1 — sign in, compose (incl. media upload), publish each mode, render through the Worker", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const posts = [
    await composeAndPublish(page, { mode: "Open", priceUsd: null, kind: "note", media: false }),
    await composeAndPublish(page, { mode: "Toll", priceUsd: "0.50", kind: "video", media: true }),
    await composeAndPublish(page, { mode: "Gated", priceUsd: "1.50", kind: "note", media: false }),
  ];
  for (const p of posts) {
    const res = await page.request.get(`${EDGE_ORIGIN}/p/${p.slug}`);
    expect(res.status(), `/p/${p.slug}`).toBe(200);
    const html = await res.text();
    expect(html).toContain(p.marker);
  }
});
