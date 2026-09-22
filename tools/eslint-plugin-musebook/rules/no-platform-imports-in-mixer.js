const DEFAULT_SCOPE = "packages/muse-mixer/src/";
const DEFAULT_ESCAPE_HATCH = "packages/muse-mixer/src/adapters/";

const DEFAULT_FORBIDDEN = [
  "pg",
  "pg-pool",
  "postgres",
  "@supabase/*",
  "@vercel/*",
  "next",
  "next/*",
  "cloudflare:*",
  "@cloudflare/*",
  "agents",
  "agents/*",
  "wrangler",
  "wrangler/*",
  "web-bot-auth",
  "web-bot-auth/*",
  "@x402/*",
  "node:*",
  "fs",
  "path",
  "crypto",
  "@musebook/x402",
  "@musebook/distributor",
  "@musebook/connectors",
  "onnxruntime-*",
];

/**
 * `x/*` matches `x` and any subpath; `x-*` (a bare trailing star) matches any
 * package whose name starts with `x-`, which is how onnxruntime-node and
 * onnxruntime-web are both caught by one entry. `cloudflare:*` catches the
 * workerd built-in namespace — `cloudflare:workers`, `cloudflare:sockets`,
 * `cloudflare:email` — which is the new way a "pure" scorer can acquire a
 * platform dependency without ever naming a package.
 * @param {string} source
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesPattern(source, pattern) {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return source === base || source.startsWith(`${base}/`);
  }
  if (pattern.endsWith("*")) {
    return source.startsWith(pattern.slice(0, -1));
  }
  return source === pattern;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "packages/muse-mixer/src must stay platform-free; only src/adapters may touch I/O.",
    },
    schema: [
      {
        type: "object",
        properties: {
          scope: { type: "string" },
          escapeHatch: { type: "string" },
          forbidden: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "'{{source}}' is a platform import. packages/muse-mixer/src must run unchanged in a Queue consumer, in Node and in an offline replay. Move this behind an interface in src/adapters/ and inject it. (spine invariant 6)",
    },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const scope = opts.scope ?? DEFAULT_SCOPE;
    const escapeHatch = opts.escapeHatch ?? DEFAULT_ESCAPE_HATCH;
    const forbidden = opts.forbidden ?? DEFAULT_FORBIDDEN;

    const filename = context.filename.split("\\").join("/");
    if (!filename.includes(scope)) return {};
    if (filename.includes(escapeHatch)) return {};

    /**
     * @param {import("estree").Node} node
     * @param {unknown} raw
     */
    const check = (node, raw) => {
      if (typeof raw !== "string") return;
      if (forbidden.some((pattern) => matchesPattern(raw, pattern))) {
        context.report({ node, messageId: "forbidden", data: { source: raw } });
      }
    };

    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.source) check(node.source, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node.source, node.source.value);
      },
      CallExpression(node) {
        const callee = node.callee;
        const isRequire = callee.type === "Identifier" && callee.name === "require";
        const first = node.arguments[0];
        if (isRequire && first && first.type === "Literal") {
          check(first, first.value);
        }
      },
    };
  },
};
