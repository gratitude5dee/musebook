const NEEDLES = ["publish_mode", "publishMode"];
const hasNeedle = (s) => NEEDLES.some((n) => s.includes(n));

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Only @musebook/kernel may reference publish_mode. Every other surface must call resolveAccess().",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "'publish_mode' may only be referenced inside packages/kernel/. Call resolveAccess(resource, actor) from @musebook/kernel and branch on the AccessDecision instead. (spine invariant: one function decides access)",
    },
  },

  create(context) {
    const allow = context.options[0]?.allow ?? [
      "packages/kernel/src/",
      "packages/kernel/test/",
            "packages/content/test/",
            "packages/x402/test/",
      "packages/schema/src/kernel.ts",
      "packages/schema/src/database.types.ts",
      "supabase/migrations/",
    ];

    // context.filename is ESLint >=9. Normalise Windows separators before matching.
    const filename = context.filename.split("\\").join("/");
    if (allow.some((prefix) => filename.includes(prefix))) return {};

    /** @param {import("estree").Node} node */
    const report = (node) => context.report({ node, messageId: "forbidden" });

    return {
      Identifier(node) {
        if (NEEDLES.includes(node.name)) report(node);
      },
      Literal(node) {
        if (typeof node.value === "string" && hasNeedle(node.value)) report(node);
      },
      TemplateElement(node) {
        if (hasNeedle(node.value.raw)) report(node);
      },
    };
  },
};
