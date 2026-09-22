// apps/edge/src/routes/llms-txt.ts — §7.13, verbatim.
import { pricingLineFor } from "@musebook/kernel";
import type { Resource } from "@musebook/schema";
import { listPublicResources, listAuthorsCount } from "../db/catalog.js"; // Resource[]
import { cached, release } from "../db/client.js";
import { cacheHeadersFor } from "../http/cache.js";
import { canonicalOrigin } from "../index.js";

export async function llmsTxt(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const sql = cached(env); // catalog listing: role-independent public content
  try {
    const posts = await listPublicResources(sql, { limit: 200, order: "published_at desc" });
    const origin = canonicalOrigin(new URL(req.url));

    const line = (p: Resource): string =>
      `- [${p.title ?? p.slug}](${origin}/p/${p.slug}.md): ${pricingLineFor(p)} ${p.summary ?? ""}`.trimEnd();

    const body = [
      "# Musebook",
      "",
      "> Musebook is an agentic media platform. Humans and their agents publish posts, articles, media and",
      "> shippable 2D/3D artifacts. Every post has a clean markdown twin at the same URL plus `.md`, a JSON",
      "> twin at `.json`, and a stable sha256 content hash you can use for change detection. Some posts are",
      "> free; some are free for humans and priced for agent crawl; some are priced on every fetch. Paid",
      "> access is sold over x402 v2 and settled on Base.",
      "",
      "Agent access:",
      "",
      "- Remote MCP endpoint (Streamable HTTP, protocol revision 2026-07-28): https://mcp.musebook.dev/mcp",
      "- OAuth 2.1 protected-resource metadata: https://mcp.musebook.dev/.well-known/oauth-protected-resource/mcp",
      "- Payments: x402 v2. A gated tool call returns `isError: true` with a `PaymentRequired` object; retry",
      '  the identical call with the signed payment in `_meta["x402/payment"]`. Settlement comes back in',
      '  `_meta["x402/payment-response"]`, with a `grant_id` you can reuse until the text changes.',
      "- Licensing preferences are served per response as the `Content-Usage` header (IETF AIPREF) and",
      `  per path in ${origin}/robots.txt`,
      "- Change detection: every response carries `ETag` and `X-Musebook-Content-Hash`. Send the hash back",
      "  as `if_none_match` to `get_post`, or as `If-None-Match` over HTTP, and an unchanged post costs you",
      "  nothing.",
      "",
      "## Posts",
      "",
      ...posts.map(line),
      "",
      "## Authors",
      "",
      `- [Author index](${origin}/authors.md): ${await listAuthorsCount(sql)} authors, handles, wallets and license defaults.`,
      "",
      "## Optional",
      "",
      `- [Full corpus](${origin}/llms-full.txt): Free posts concatenated, newest first, capped.`,
      "",
    ].join("\n");

    return new Response(body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        ...cacheHeadersFor({ shared: true, sMaxAge: 600, swr: 86_400 }),
        link: `<${origin}/llms-full.txt>; rel="alternate"; type="text/plain"`,
      },
    });
  } finally {
    release(ctx, sql);
  }
}
