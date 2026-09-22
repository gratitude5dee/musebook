import { RuleTester } from "eslint";
import tseslintParser from "@typescript-eslint/parser";
import { describe, it } from "vitest";
import rule from "./no-publish-mode-outside-kernel.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslintParser,
    ecmaVersion: 2023,
    sourceType: "module",
  },
});

tester.run("no-publish-mode-outside-kernel", rule, {
  valid: [
    {
      filename: "packages/kernel/src/access.ts",
      code: `const mode = row.publish_mode;`,
    },
    {
      filename: "packages/kernel/test/golden.test.ts",
      code: `const mode = row.publishMode;`,
    },
    {
      filename: "packages/schema/src/kernel.ts",
      code: `export const resourceSchema = z.object({ publishMode: z.string() });`,
    },
    {
      filename: "supabase/migrations/20260922090300_content.sql.ts",
      code: `const ddl = "alter table posts add publish_mode text";`,
    },
    {
      filename: "apps/edge/src/routes.ts",
      code: `const decision = await resolveAccess(resource, actor);`,
    },
    {
      filename: "packages/distributor/src/outbound.ts",
      code: `const field = "publish_at";`,
    },
  ],
  invalid: [
    {
      filename: "apps/edge/src/read.ts",
      code: `const row = db.select("id, publish_mode");`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "apps/edge/src/resolve.ts",
      code: `if (resource.publishMode === "x402_always") {}`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "apps/web/app/feed/page.tsx",
      code: `const q = \`select * from posts where publish_mode = 'paid'\`;`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "apps/mcp/src/tools.ts",
      code: `const publish_mode = "free";`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "packages/muse-mixer/src/scorers/s.ts",
      code: `const boosted = candidate.publishMode ? 1 : 0;`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "packages/schema/src/env.ts",
      code: `const key = "publish_mode";`,
      errors: [{ messageId: "forbidden" }],
    },
  ],
});
