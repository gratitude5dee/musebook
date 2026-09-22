// §11 (M16): no node: native binding in a Worker. The node: modules below
// have no workerd implementation at any compatibility_date — importing one
// bundles code that cannot run. (Pure-JS-capable modules like node:crypto
// are deliberately absent: they work and are not this rule's business.)
const FORBIDDEN = [
  "node:fs",
  "node:path",
  "node:net",
  "node:child_process",
  "node:cluster",
  "node:worker_threads",
  "node:dgram",
];
const WORKER_SCOPES = ["apps/edge/src/", "apps/mcp/src/", "apps/worker/src/"];

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "No unimplementable node: module inside a Worker's src. workerd has no fs, path, net, child_process, cluster, worker_threads or dgram.",
    },
    schema: [],
    messages: {
      forbidden:
        "'{{source}}' cannot exist on workerd. If a package needs it, that package belongs in apps/web or outside the request path entirely. (§11)",
    },
  },

  create(context) {
    const filename = context.filename.split("\\").join("/");
    if (!WORKER_SCOPES.some((s) => filename.includes(s))) return {};
    const check = (node, raw) => {
      if (typeof raw === "string" && FORBIDDEN.includes(raw)) {
        context.report({ node, messageId: "forbidden", data: { source: raw } });
      }
    };
    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node.source, node.source.value);
      },
      CallExpression(node) {
        const callee = node.callee;
        const first = node.arguments[0];
        if (
          callee.type === "Identifier" &&
          callee.name === "require" &&
          first &&
          first.type === "Literal"
        ) {
          check(first, first.value);
        }
      },
    };
  },
};
