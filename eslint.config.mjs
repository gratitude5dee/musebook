import eslint from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import musebook from "@musebook/eslint-plugin";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/worker-configuration.d.ts",
      "packages/schema/src/database.types.ts",
      // Static assets served verbatim; unlock.js is the no-JS checkout script
      // and lives in no tsconfig.
      "apps/web/public/**",
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    plugins: { musebook },
    rules: {
      // Spine invariants, as errors. Never downgrade these.
      "musebook/no-publish-mode-outside-kernel": "error",
      "musebook/no-platform-imports-in-mixer": "error",

      // The three later rules (§3.4's table). They are listed here explicitly
      // at "off" rather than omitted, so that turning one on at its milestone
      // is a one-word diff on a line that already exists, and so that a reader
      // can see all five rules in one place.
      //   M11 (§13): on — no action_events write on a serve path.
      "musebook/no-action-events-at-serve-time": "error",
      //   M16 (§11): flip to "error" — no node: native binding in a Worker.
      "musebook/no-node-native-in-worker": "off",
      //   M16 (§11): flip to "error" — artifacts never share the page origin.
      "musebook/no-same-origin-artifact-sandbox": "off",

      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // Invariant 5: weights load per-request from the ranking_weights row.
          selector: "VariableDeclarator[id.name=/^(WEIGHTS|RANKING_WEIGHTS|DEFAULT_WEIGHTS)$/]",
          message:
            "Ranking weights must be loaded at runtime from the ranking_weights row keyed by weights_version. Never compile a weight table into the bundle. (spine invariant 5)",
        },
      ],
      // Jev classifies only. The one package that may talk to it is @musebook/classify.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@typesafe-ai/sdk",
              message:
                "Only packages/classify may call Jev. Import classifyOne from @musebook/classify instead.",
            },
          ],
          patterns: [
            {
              group: ["@ai-sdk/typesafe-ai"],
              message:
                "Not used: it reads a different env var and renames the answer fields (section 8.2).",
            },
          ],
        },
      ],
    },
  },

  {
    // @musebook/classify may import Jev, and may NOT import a generator.
    // Generation is generateObject/generateText via AI Gateway (GEN_MODEL /
    // REFORMAT_MODEL, section 3.7); Jev is never a generator.
    files: ["packages/classify/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "ai", message: "packages/classify classifies; it never generates." }],
          patterns: [
            { group: ["@ai-sdk/*"], message: "packages/classify classifies; it never generates." },
          ],
        },
      ],
    },
  },

  {
    // THE EDGE WORKER. CF-SPINE §6: import x402 by SUBPATH only. The root
    // barrel of @x402/evm drags in viem plus fs/path batch settlement, and
    // @x402/paywall is a browser bundle (React 19 + wagmi + WalletConnect +
    // Solana + Algorand). None of it belongs in a 64 MiB Worker with a
    // 1-second startup budget. This is the FIRST of two guards; the second
    // (§3.4, "the bundle guard") greps the actual built output, because an
    // import can arrive transitively without any file here naming it.
    files: ["apps/edge/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@x402/evm",
              message:
                "Import '@x402/evm/exact/server'. The root barrel pulls viem and fs-backed batch settlement (CF-SPINE §6).",
            },
            { name: "@x402/core", message: "Import '@x402/core/server' or '@x402/core/http'." },
            {
              name: "viem",
              message:
                "No EIP-712 recovery at the edge. Settlement is delegated to the facilitator (CF-SPINE §6).",
            },
            {
              name: "@x402/paywall",
              message: "Browser bundle. It belongs in apps/web, never in a Worker.",
            },
            {
              name: "@modelcontextprotocol/server",
              message:
                "The MCP SDK lives in apps/mcp. Co-locating it here ships a second zod and risks the 1s startup limit (CF-SPINE §9, §3.2).",
            },
            {
              name: "zod",
              message:
                "apps/edge must not declare zod. It gets zod 3 transitively through @x402/core; see the zod split in §3.2.",
            },
          ],
          patterns: [
            {
              group: ["viem/*"],
              message: "Never import viem, and never 'viem/node' (node:net, node:path, node:url).",
            },
            {
              group: ["@x402/evm/batch-settlement/*"],
              message: "The only fs/path paths in @x402/evm. Not importable on workerd.",
            },
            { group: ["@modelcontextprotocol/*"], message: "The MCP SDK lives in apps/mcp." },
          ],
        },
      ],
    },
  },

  {
    // THE MCP WORKER. CF-SPINE §9: agents@0.24.0's createMcpHandler, not
    // mcp-handler, and never McpAgent (deprecated, feature-frozen, Durable
    // Object session state that MCP 2026-07-28 made unnecessary).
    files: ["apps/mcp/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "mcp-handler",
              message:
                "Redundant: it calls the same createMcpHandler and adds no Host/Origin validation. Use agents/mcp/server (CF-SPINE §9).",
            },
            {
              name: "@modelcontextprotocol/server/validators/ajv",
              message:
                "ajv codegens with new Function, which throws outside the Worker startup phase. Use ./validators/cf-worker.",
            },
            { name: "next", message: "There is no Next.js in this Worker." },
          ],
          patterns: [
            {
              group: ["@x402/*"],
              message:
                "x402 over MCP uses Cloudflare's agents/x402 (withX402, paidTool), not the HTTP resource server (CF-SPINE §9).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportSpecifier[imported.name='McpAgent']",
          message:
            "McpAgent is DEPRECATED and feature-frozen. Its Durable Object session state is legacy now that MCP 2026-07-28 is stateless. (CF-SPINE §9)",
        },
      ],
    },
  },

  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // CF-SPINE §1: real client IP is Enterprise-only behind a Cloudflare
      // proxy. These four read a header the origin no longer receives, and
      // they fail SILENTLY — they return a plausible wrong answer, not an error.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^x-vercel-ip-/]",
          message:
            "Dead behind Cloudflare. The Worker reads request.cf and forwards signed x-mb-* headers; read those instead (CF-SPINE §1, §15.10).",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "botid/server",
              message:
                "BotID is replaced by web-bot-auth verification in the edge Worker (CF-SPINE §7).",
            },
            {
              name: "@vercel/blob",
              message:
                "Vercel Blob is replaced by R2 (CF-SPINE §5). Media URLs come from cdn.musebook.dev or media.musebook.dev.",
            },
          ],
          patterns: [
            {
              group: ["@vercel/functions"],
              message:
                "geolocation() and ipAddress() are dead behind a Cloudflare proxy; attachDatabasePool has no Vercel pg pool left to attach (CF-SPINE §1, §2).",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },

  {
    // Gate fixtures deliberately import modules that do not exist — they are
    // lint fixtures, not typechecked code. Root *.mjs configs sit outside
    // every tsconfig, so the project service cannot type-check them either.
    files: ["**/test/fixtures/**", "apps/*/postcss.config.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },

  // Must stay last: turns off every rule Prettier owns.
  prettierConfig,
);
