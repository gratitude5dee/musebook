/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  tabWidth: 2,
  arrowParens: "always",
  endOfLine: "lf",
  overrides: [
    { files: "*.md", options: { proseWrap: "preserve" } },
    { files: "*.sql", options: { printWidth: 120 } },
    // wrangler.jsonc carries comments that explain non-obvious limits and
    // CF-SPINE constraints. The jsonc parser preserves them; the json parser
    // would refuse the file outright.
    { files: "*.jsonc", options: { parser: "jsonc", trailingComma: "none" } },
  ],
};
