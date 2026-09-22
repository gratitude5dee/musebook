// packages/kernel/src/render/feed.ts — the JSON Feed item (§6.6).
// Feed items are metadata plus a link: content_text is the summary only, never a
// body — a feed that ever carried a paid body would leak it to every subscriber,
// because feed readers cache aggressively and across users. bodyKind is ignored.
import type { Resource } from "@musebook/schema";

export function renderFeed(resource: Resource, origin: string): Record<string, unknown> {
  return {
    id: `${origin}/p/${resource.slug}`,
    url: `${origin}/p/${resource.slug}`,
    title: resource.title ?? resource.summary ?? resource.slug,
    content_text: resource.summary ?? "",
    summary: resource.summary,
    date_published: resource.publishedAt,
    date_modified: resource.updatedAt,
    authors: [{ name: resource.authorDisplayName, url: `${origin}/@${resource.authorHandle}` }],
    tags: resource.tags,
  };
}
