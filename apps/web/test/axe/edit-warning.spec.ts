// M7 gate 7 — editing a post that already has a grant renders the fingerprint
// warning, asserted by Playwright on the composer, by substring.
import { test, expect } from "@playwright/test";
import { SEED_COOKIE } from "./playwright.config";

// seed-article-hfap (4444…0005) carries the seed's access_grants row.
const POST_ID = "44444444-4444-4444-8444-000000000005";
const WARNING_SUBSTRING = "fingerprint";

test("edit-after-grant warns about the changed fingerprint", async ({ page, context }) => {
  await context.addCookies([
    { name: "mb_session", value: SEED_COOKIE.split("=")[1] ?? "", url: "http://127.0.0.1" },
  ]);
  await page.goto(`/compose/${POST_ID}`);
  const editor = page.getByPlaceholder("Write, or ask your agent to.");
  await editor.click();
  await editor.pressSequentially("a");
  // Autosave arms the warning on the 3s tick; the dialog is an alertdialog.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText(WARNING_SUBSTRING);
  await expect(dialog).toContainText("they keep what they bought");
});
