// packages/schema/src/view.ts — PostView, the UI projection apps/web reads
// (§7.12). It is what `loadPostView` returns: the .json twin's post + body +
// preview + access, plus the non-gated posts columns PostgREST carries that
// the kernel envelope does not (og_image_url).
import { z } from "zod";
import { licenseSpdxSchema, postKindSchema } from "./kernel";

export const postViewSchema = z.object({
  postId: z.uuid(),
  slug: z.string(),
  kind: postKindSchema,
  title: z.string().nullable(),
  summary: z.string().nullable(),
  authorUserId: z.uuid(),
  authorHandle: z.string(),
  authorDisplayName: z.string(),
  languageCode: z.string(),
  tags: z.array(z.string()),
  contentHash: z.string(),
  canonicalUrl: z.string().nullable(),
  ogImageUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
  // The access shape — from the twin's accessBadge + body/preview envelope.
  body: z.string().nullable(),
  preview: z.string().nullable(),
  accessBadge: z.object({
    kind: z.enum(["open", "toll", "gated"]),
    priceUsd: z.string().optional(),
    rule: z.string(),
  }),
  // License is first-class (§4.4).
  licenseSpdx: licenseSpdxSchema,
  licenseUrl: z.string().nullable(),
  trainAi: z.boolean(),
  aiUse: z.boolean(),
  attributionRequired: z.boolean(),
  citationTemplate: z.string().nullable(),
  // The price columns, verbatim numerics-as-strings (§14.4.5).
  priceAtomic: z.string(),
  priceAsset: z.string().nullable(),
  priceNetwork: z.string().nullable(),
  priceUsd: z.string().nullable(),
  // The JSON-LD block the Worker rendered, echoed into <script>.
  jsonld: z.record(z.string(), z.unknown()).nullable(),
});
export type PostView = z.infer<typeof postViewSchema>;
