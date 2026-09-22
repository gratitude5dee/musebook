// §13 (M11): action_events is written by musebook-worker's consumers only.
// A serve path (apps/web, apps/edge, apps/mcp) that names the table is a
// telemetry write on the request path — telemetry goes through TELEMETRY
// (Analytics Engine), never through a synchronous SQL write at serve time.
const NEEDLE = "action_events";
const SERVE_SCOPES = ["apps/web/", "apps/edge/", "apps/mcp/"];

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "No action_events read or write on a serve path. Telemetry is appended by musebook-worker from Analytics Engine, never inline in a request.",
    },
    schema: [],
    messages: {
      forbidden:
        "'action_events' on a serve path. The request path writes to TELEMETRY (Analytics Engine); only musebook-worker's rollup consumers touch the action_events tables. (§13)",
    },
  },

  create(context) {
    const filename = context.filename.split("\\").join("/");
    if (!SERVE_SCOPES.some((s) => filename.includes(s))) return {};
    const report = (node) => context.report({ node, messageId: "forbidden" });
    return {
      Identifier(node) {
        if (node.name === NEEDLE) report(node);
      },
      Literal(node) {
        if (typeof node.value === "string" && node.value.includes(NEEDLE)) report(node);
      },
      TemplateElement(node) {
        if (node.value.raw.includes(NEEDLE)) report(node);
      },
    };
  },
};
