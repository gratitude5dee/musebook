// apps/web/app/api/posts/[postId]/license/route.ts — §7.17 get_license_terms'
// backing route and the JSON-LD usageInfo target. Serves the seven §4.4
// license columns — the same object get_post embeds. Public: the license is
// metadata the page itself already publishes.
export const runtime = "nodejs";

import { serviceDb } from "@/lib/db/service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const { data } = await serviceDb
    .from("posts")
    .select(
      "license_spdx, license_url, train_ai, ai_use, search_indexable, attribution_required, citation_template",
    )
    .eq("id", postId)
    .maybeSingle()
    .returns<{
      license_spdx: string;
      license_url: string | null;
      train_ai: boolean;
      ai_use: boolean;
      search_indexable: boolean;
      attribution_required: boolean;
      citation_template: string | null;
    }>();
  if (data === null) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    spdx: data.license_spdx,
    url: data.license_url,
    train_ai: data.train_ai,
    ai_use: data.ai_use,
    search: data.search_indexable,
    attribution_required: data.attribution_required,
    citation_template: data.citation_template,
  });
}
