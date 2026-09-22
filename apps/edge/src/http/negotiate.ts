// apps/edge/src/http/negotiate.ts — §7.10.2 verbatim.
// markdown wins only when the client stated a strictly stronger preference for
// it than for html and for the wildcard — an equal q is a browser tie, and
// browsers get html.
export function prefersMarkdown(accept: string | null): boolean {
  if (accept === null || accept === "") return false;
  const q = (type: string): number => {
    const m = accept.match(
      new RegExp(
        `(?:^|,)\\s*${type.replace(/[/.]/g, "\\$&")}\\s*(?:;\\s*q\\s*=\\s*([0-9.]+))?`,
        "i",
      ),
    );
    if (m === null) return 0;
    return m[1] === undefined ? 1 : Math.min(Math.max(Number(m[1]), 0), 1);
  };
  return q("text/markdown") > Math.max(q("text/html"), q("\\*\\*"));
}
