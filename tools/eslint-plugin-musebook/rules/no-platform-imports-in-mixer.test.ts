import { RuleTester } from "eslint";
import tseslintParser from "@typescript-eslint/parser";
import { describe, it } from "vitest";
import rule from "./no-platform-imports-in-mixer.js";

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

tester.run("no-platform-imports-in-mixer", rule, {
  valid: [
    {
      // the adapters/ escape hatch
      filename: "packages/muse-mixer/src/adapters/pg.ts",
      code: `import { Pool } from "pg";`,
    },
    {
      filename: "packages/muse-mixer/src/scorers/engagement.ts",
      code: `import { cosine } from "../math.js";`,
    },
    {
      // outside the mixer's scope entirely — not this rule's business
      filename: "apps/worker/src/consumers/classify.ts",
      code: `import { Pool } from "pg";`,
    },
    {
      filename: "packages/muse-mixer/src/pipeline.ts",
      code: `import type { Candidate } from "@musebook/schema";`,
    },
  ],
  invalid: [
    {
      filename: "packages/muse-mixer/src/scorers/engagement.ts",
      code: `import { Pool } from "pg";`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "packages/muse-mixer/src/scorers/engagement.ts",
      code: `import { env } from "cloudflare:workers";`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "packages/muse-mixer/src/embed/onnx.ts",
      code: `import * as ort from "onnxruntime-node";`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "packages/muse-mixer/src/index.ts",
      code: `export { settle } from "@musebook/x402";`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "packages/muse-mixer/src/dynamic.ts",
      code: `const kv = await import("cloudflare:workers");`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      filename: "packages/muse-mixer/src/read.ts",
      code: `import { readFileSync } from "node:fs";`,
      errors: [{ messageId: "forbidden" }],
    },
  ],
});
