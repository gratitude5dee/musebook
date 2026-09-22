// §11 (M16): artifact content (user-generated HTML) is served from
// artifacts.musebook.dev, a separate origin — never inline in the page
// origin. An <iframe srcDoc> or a route handler that streams artifact
// bytes under musebook.dev puts untrusted markup inside the session's
// trust boundary.
const ARTIFACT_NEEDLE = "ARTIFACTS";
const PAGE_SCOPES = ["apps/web/"];

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Artifacts never share the page origin. apps/web must not render artifact bytes inline (srcDoc) or read the ARTIFACTS bucket.",
    },
    schema: [],
    messages: {
      forbidden:
        "Artifact content in the page origin. Serve it from artifacts.musebook.dev (separate origin, sandboxed); the web app links to it, it never embeds it. (§11)",
    },
  },

  create(context) {
    const filename = context.filename.split("\\").join("/");
    if (!PAGE_SCOPES.some((s) => filename.includes(s))) return {};
    const report = (node) => context.report({ node, messageId: "forbidden" });
    return {
      JSXAttribute(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "srcDoc") report(node);
      },
      Identifier(node) {
        if (node.name === ARTIFACT_NEEDLE) report(node);
      },
    };
  },
};
