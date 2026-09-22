import { RuleTester } from "eslint";
import tseslintParser from "@typescript-eslint/parser";
import { describe, it } from "vitest";
import noActionEventsAtServeTime from "./no-action-events-at-serve-time.js";
import noNodeNativeInWorker from "./no-node-native-in-worker.js";
import noSameOriginArtifactSandbox from "./no-same-origin-artifact-sandbox.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslintParser,
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

tester.run("no-action-events-at-serve-time", noActionEventsAtServeTime, {
  valid: [
    {
      filename: "apps/worker/src/consumers/rollup.ts",
      code: `const table = "action_events";`,
    },
    {
      filename: "packages/muse-mixer/src/scorers/s.ts",
      code: `const w = 1.0;`,
    },
  ],
  invalid: [
    {
      filename: "apps/edge/src/serve.ts",
      code: `await db.query("insert into action_events (kind) values ($1)");`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "apps/mcp/src/tools.ts",
      code: `const action_events = [];`,
      errors: [{ messageId: "forbidden" }],
    },
  ],
});

tester.run("no-node-native-in-worker", noNodeNativeInWorker, {
  valid: [
    {
      filename: "apps/edge/src/index.ts",
      code: `import { createHash } from "node:crypto";`,
    },
    {
      filename: "packages/muse-mixer/src/s.ts",
      code: `import { readFileSync } from "node:fs";`,
    },
  ],
  invalid: [
    {
      filename: "apps/worker/src/consumers/media.ts",
      code: `import { readFileSync } from "node:fs";`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "apps/edge/src/net.ts",
      code: `import { createConnection } from "node:net";`,
      errors: [{ messageId: "forbidden" }],
    },
  ],
});

tester.run("no-same-origin-artifact-sandbox", noSameOriginArtifactSandbox, {
  valid: [
    {
      filename: "apps/web/app/a/[id]/page.tsx",
      code: `const el = <iframe src="https://artifacts.musebook.dev/x" sandbox="allow-scripts" />;`,
    },
    {
      filename: "apps/edge/src/artifacts.ts",
      code: `const body = await env.ARTIFACTS.get(key);`,
    },
  ],
  invalid: [
    {
      filename: "apps/web/app/a/[id]/page.tsx",
      code: `const el = <iframe srcDoc={html} />;`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "apps/web/app/api/a/route.ts",
      code: `const obj = await env.ARTIFACTS.get(key);`,
      errors: [{ messageId: "forbidden" }],
    },
  ],
});
