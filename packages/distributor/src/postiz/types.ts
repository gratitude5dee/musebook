// packages/distributor/src/postiz/types.ts — §12.2.4 verbatim.
// CreatePostDto mirror, written from the spec — never from Postiz's source.
export interface PostizMediaRef {
  /** Media id returned by /upload-from-url. */
  readonly id: string;
  /** Path returned by /upload-from-url. MUST contain RESTRICT_UPLOAD_DOMAINS. */
  readonly path: string;
  readonly alt?: string;
  readonly thumbnail?: string;
}

export interface PostizPostContent {
  /** HTML/markdown/plaintext per the channel's editor mode. See 12.3.1. */
  readonly content: string;
  readonly image: PostizMediaRef[];
}

export interface PostizPostEntry {
  readonly integration: { readonly id: string };
  /** value[0] is the root post; value[1..n] are thread replies / comments. */
  readonly value: PostizPostContent[];
  /** Provider settings DTO. NEVER set __type — mapTypeToPost injects it. */
  readonly settings: Record<string, unknown>;
  readonly group?: string;
}

export interface PostizCreatePostBody {
  readonly type: "draft" | "schedule" | "now" | "update";
  /** ISO-8601. Required even for type:"now" (@IsDateString). */
  readonly date: string;
  readonly shortLink: boolean;
  readonly tags: { readonly value: string; readonly label: string }[];
  readonly posts: PostizPostEntry[];
  /** Required to re-publish an already-PUBLISHED post. */
  readonly republish?: boolean;
}
