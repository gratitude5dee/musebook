// packages/classify/src/state.ts
import type { PostKind } from "@musebook/schema";

export type PostState = {
  /** §4.2 `post_kind`: 'note' | 'article' | 'image' | 'video' | 'audio' | 'app' | 'model3d' | 'thread'. */
  kind: PostKind;
  title: string | null;
  summary: string | null;
  body: string; // canonical markdown, truncated — see BODY_CHAR_BUDGET
  declared_tags: string[]; // creator-supplied: a prior, never ground truth
  declared_language: string; // posts.language_code
  media: { content_type: string; duration_ms: number | null; alt_text: string | null }[];
  artifact: { runtime: string } | null; // non-null only when kind is 'app' or 'model3d'
  author: { kind: "human" | "agent"; agent_model: string | null };
  link_hosts: string[]; // hostnames only, never full URLs with query strings
};

/** Body is truncated, not chunked: the battery judges a post, not every sentence of it. */
export const BODY_CHAR_BUDGET = 12_000;

export function truncateBody(markdown: string): string {
  return markdown.length <= BODY_CHAR_BUDGET
    ? markdown
    : `${markdown.slice(0, BODY_CHAR_BUDGET)}\n\n[truncated at ${BODY_CHAR_BUDGET} characters]`;
}
