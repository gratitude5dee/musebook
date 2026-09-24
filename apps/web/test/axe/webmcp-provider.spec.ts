// GATE M18.2 — a WebMCP provider present: the five post tools register, and
// every one of them is aborted when the page navigates away. The abort is
// asserted, not assumed — a tool that outlives its page is a tool registered
// against a post the user has left. localStorage records the aborts: a client
// navigation unmounts the component, which is the only unmount a React effect
// cleanup ever observes (full document unload does not run cleanups).
//
// M18.4's DOM half also lives here: no origin-trial meta renders while
// NEXT_PUBLIC_WEBMCP_OT_TOKEN is unset (the test env never sets it).
import { test, expect } from "@playwright/test";

const TOOL_NAMES = [
  "read_article",
  "cite_passage",
  "get_license_terms",
  "pay_and_unlock",
  "ask_author",
] as const;

const INSTALL_PROVIDER = `
  (() => {
    localStorage.removeItem("__webmcpAborted");
    window.__webmcpRegistered = [];
    const modelContext = {
      registerTool(tool, options) {
        window.__webmcpRegistered.push(tool.name);
        const signal = options && options.signal;
        if (signal && typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", () => {
            const cur = JSON.parse(localStorage.getItem("__webmcpAborted") || "[]");
            cur.push(tool.name);
            localStorage.setItem("__webmcpAborted", JSON.stringify(cur));
          });
        }
        return Promise.resolve();
      },
    };
    Object.defineProperty(document, "modelContext", {
      value: modelContext,
      configurable: true,
      writable: false,
    });
  })();
`;

test("M18.2: provider present registers the five post tools, all aborted on navigation", async ({
  page,
}) => {
  await page.addInitScript(INSTALL_PROVIDER);
  const res = await page.goto("/p/seed-article-free", { waitUntil: "load" });
  expect(res?.status()).toBe(200);

  // Registrations are awaited in the component's effect — poll for all five.
  await page.waitForFunction(
    (names) =>
      names.every((n) =>
        (window as unknown as { __webmcpRegistered: string[] }).__webmcpRegistered.includes(n),
      ),
    TOOL_NAMES as readonly string[],
    { timeout: 15_000 },
  );
  const registered = await page.evaluate(() =>
    (window as unknown as { __webmcpRegistered: string[] }).__webmcpRegistered.slice(),
  );
  expect([...registered].sort()).toEqual([...TOOL_NAMES].sort());

  // M18.4: no origin-trial meta while the token env is unset.
  expect(await page.locator('meta[http-equiv="origin-trial"]').count()).toBe(0);

  // Clicking the byline is a soft navigation (the only in-app link on the
  // page): it unmounts the component tree, so the effect's cleanup runs and
  // every registered tool aborts. A document navigation would not run the
  // cleanup — React effects have no unload hook.
  await page.getByRole("link", { name: "Seed Creator" }).click();
  await page.waitForURL(/\/@seed_creator/);
  await page.waitForFunction(
    (names) => {
      const aborted = JSON.parse(localStorage.getItem("__webmcpAborted") || "[]") as string[];
      return names.every((n) => aborted.includes(n));
    },
    TOOL_NAMES as readonly string[],
    { timeout: 10_000 },
  );
});

// M18.3 — no provider: the component contributes zero DOM. "Byte-identical"
// reduces to the observable surface: the component returns null, so its entire
// possible DOM contribution is nothing. (Flight data embeds client-module
// paths, so a raw-HTML string grep would false-positive on the manifest.)
test("M18.3: provider absent contributes no DOM to /p/{slug}", async ({ page }) => {
  const res = await page.goto("/p/seed-article-free", { waitUntil: "load" });
  expect(res?.status()).toBe(200);
  expect(await page.evaluate(() => "modelContext" in document)).toBe(false);
  const contribution = await page.evaluate(() => ({
    attributedNodes: document.querySelectorAll("[data-webmcp], [data-model-context]").length,
    inlineRegistrarScripts: [...document.querySelectorAll("script")].filter((s) =>
      s.textContent?.includes("modelContext.registerTool"),
    ).length,
  }));
  expect(contribution).toEqual({ attributedNodes: 0, inlineRegistrarScripts: 0 });
  expect(await page.locator("main, article").first().isVisible()).toBe(true);
});
