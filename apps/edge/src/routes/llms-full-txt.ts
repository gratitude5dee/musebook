// apps/edge/src/routes/llms-full-txt.ts — §7.13, verbatim: free posts only,
// newest first, hard byte budget.
import { toAccessBadge } from "@musebook/kernel";
import { listPublicResources } from "../db/catalog.js";
import { cached, release } from "../db/client.js";
import { cacheHeadersFor } from "../http/cache.js";
import { canonicalOrigin } from "../index.js";

export async function llmsFullTxt(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const MAX_BYTES = Number(env.LLMS_FULL_MAX_BYTES ?? 4_000_000); // 4 MB
  if (MAX_BYTES === 0) return new Response("Not found\n", { status: 404 });

  const sql = cached(env);
  try {
    const all = await listPublicResources(sql, { limit: 500, order: "published_at desc" });
    const posts = all.filter((p) => toAccessBadge(p).kind === "open");
    const origin = canonicalOrigin(new URL(req.url));
    const yn = (b: boolean): string => (b ? "y" : "n");
    const enc = new TextEncoder();

    const chunks: string[] = [];
    let bytes = 0;
    let included = 0;

    for (const p of posts) {
      const chunk =
        `\n\n---\n\n# ${p.title ?? p.slug}\n` +
        `Source: ${origin}/p/${p.slug}\nContent-Hash: ${p.contentHash}\n` +
        `Published: ${p.publishedAt}\n` +
        `License: ${p.licenseSpdx}${p.licenseUrl ? ` (${p.licenseUrl})` : ""}\n` +
        `Content-Usage: train-ai=${yn(p.trainAi)}, ai-use=${yn(p.aiUse)}, search=${yn(p.searchIndexable)}\n` +
        `Attribution-Required: ${yn(p.attributionRequired)}\n` +
        (p.citationTemplate ? `Cite-As: ${p.citationTemplate}\n` : "") +
        `\n${p.canonicalMarkdown}`;
      const size = enc.encode(chunk).length; // no Buffer on workerd; TextEncoder is the byte length
      if (bytes + size > MAX_BYTES) break;
      chunks.push(chunk);
      bytes += size;
      included += 1;
    }

    return new Response(
      `# Musebook — full corpus (free posts)\n` +
        `# ${included} of ${posts.length} free posts, newest first, capped at ${MAX_BYTES} bytes.\n` +
        `# The authoritative index is ${origin}/llms.txt\n` +
        chunks.join(""),
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          ...cacheHeadersFor({ shared: true, sMaxAge: 3600, swr: 86_400 }),
        },
      },
    );
  } finally {
    release(ctx, sql);
  }
}
