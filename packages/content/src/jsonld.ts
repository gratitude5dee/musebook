// packages/content/src/jsonld.ts — the schema.org document behind the
// `.jsonld` twin and the inline `<script type="application/ld+json">` embed.
//
// This is the ACCESS-NEUTRAL base document only: `isAccessibleForFree` and
// the `hasPart` paywall element are decision fields, and the kernel's
// render/jsonld.ts (§6.6, M5) is the only code allowed to compute them —
// this package never reads the mode (the no-publish-mode-outside-kernel
// lint makes that mechanical).
import type { PostKind, Resource } from "@musebook/schema";

/**
 * The `@id` fragment for the creative-work node, one per §4.2 `post_kind`.
 * Text kinds collapse to `post`; the media and artifact kinds keep their own
 * fragment so a sibling `VideoObject` / `SoftwareApplication` / `3DModel`
 * node in the same `@graph` can be addressed independently (§7.12).
 */
export function fragmentFor(kind: PostKind): string {
  switch (kind) {
    case "note":
    case "article":
    case "thread":
      return "post";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "app":
      return "app";
    case "model3d":
      return "model3d";
  }
}

/**
 * Canonical deed URL per SPDX id; 'ARR' has none and yields null, so
 * `usageInfo` — `/api/posts/{id}/license` (§7.17) — is the only
 * machine-readable statement of terms for an all-rights-reserved post.
 */
export function spdxUrl(spdx: Resource["licenseSpdx"]): string | null {
  switch (spdx) {
    case "CC0-1.0":
      return "https://creativecommons.org/publicdomain/zero/1.0/";
    case "CC-BY-4.0":
      return "https://creativecommons.org/licenses/by/4.0/";
    case "CC-BY-SA-4.0":
      return "https://creativecommons.org/licenses/by-sa/4.0/";
    case "CC-BY-NC-4.0":
      return "https://creativecommons.org/licenses/by-nc/4.0/";
    case "CC-BY-ND-4.0":
      return "https://creativecommons.org/licenses/by-nd/4.0/";
    case "MIT":
      return "https://spdx.org/licenses/MIT.html";
    case "Apache-2.0":
      return "https://spdx.org/licenses/Apache-2.0.html";
    case "ARR":
      return null;
  }
}

export function jsonLdBase(resource: Resource, origin: string): Record<string, unknown> {
  const id = `${origin}/p/${resource.slug}`;
  const doc: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": resource.kind === "article" ? "Article" : "SocialMediaPosting",
    // The creative work and the page it lives on are two nodes, so they
    // cannot share an `@id`. The work gets a kind fragment; the page keeps
    // the bare post URL.
    "@id": `${id}#${fragmentFor(resource.kind)}`,
    mainEntityOfPage: { "@type": "WebPage", "@id": id },
    headline: resource.title ?? resource.summary ?? resource.slug,
    description: resource.summary,
    inLanguage: resource.languageCode,
    datePublished: resource.publishedAt,
    dateModified: resource.updatedAt,
    keywords: resource.tags.join(", "),
    author: {
      "@type": "Person",
      name: resource.authorDisplayName,
      url: `${origin}/@${resource.authorHandle}`,
    },
    publisher: { "@type": "Organization", name: "Musebook", url: origin },
    // License is a stored fact on the posts row (§4.4), never inferred.
    license: resource.licenseUrl ?? spdxUrl(resource.licenseSpdx),
    usageInfo: `${origin}/api/posts/${resource.postId}/license`,
  };
  return doc;
}
