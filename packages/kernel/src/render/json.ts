// packages/kernel/src/render/json.ts — the .json twin envelope (§6.6).
import type { AccessDecision, Resource } from "@musebook/schema";
import { toAccessBadge } from "../view";
import { jsonLdFor } from "./jsonld";
import { previewOf } from "./preview";

export function renderJson(
  resource: Resource,
  decision: AccessDecision,
  origin: string,
  previewChars: number,
): Record<string, unknown> {
  if (decision.bodyKind === "empty") {
    return { error: decision.allow ? "unavailable" : decision.reason };
  }

  const url = `${origin}/p/${resource.slug}`;
  const paid = resource.publishMode !== "free";

  const envelope: Record<string, unknown> = {
    schema: "musebook-post-v1",
    post: {
      postId: resource.postId,
      slug: resource.slug,
      kind: resource.kind,
      url,
      title: resource.title,
      summary: resource.summary,
      author: {
        handle: resource.authorHandle,
        displayName: resource.authorDisplayName,
      },
      language: resource.languageCode,
      publishedAt: resource.publishedAt,
      updatedAt: resource.updatedAt,
      tags: resource.tags,
      license: resource.licenseSpdx,
      contentHash: resource.contentHash,
    },
    accessBadge: toAccessBadge(resource),
    body: decision.bodyKind === "full" ? resource.canonicalMarkdown : null,
    preview:
      decision.bodyKind === "preview" ? previewOf(resource.canonicalMarkdown, previewChars) : null,
    payment: {
      required: paid,
      priceAtomic: resource.priceAtomic,
      priceAsset: resource.priceAsset,
      priceUsd: resource.priceUsd,
      priceNetwork: resource.priceNetwork,
    },
    jsonld: jsonLdFor(resource, decision, origin),
  };

  if (!decision.allow && decision.challenge !== null) {
    envelope.paymentRequired = decision.challenge;
  }
  return envelope;
}
