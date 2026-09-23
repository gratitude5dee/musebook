// packages/distributor/src/constraints.ts — the platforms row as a type,
// loaded through an injected adapter (spine invariant 6: no pg import here).
// `postizMaxChars` is the LIVE sidecar ceiling from channel_constraint_overrides
// (12.3.2) — a number in our database, never a constant from Postiz's tree.
// `cdnHost` rides the constraint so the pure validator needs no env access.
import type { CountMethod } from "./count";

export type PlatformEditor = "none" | "normal" | "markdown" | "html";
export type HashtagStyle = "inline" | "trailing" | "none" | "field";

export interface PlatformConstraint {
  readonly slug: string;
  readonly displayName: string;
  readonly maxChars: number;
  readonly countMethod: CountMethod;
  readonly editor: PlatformEditor;
  readonly minMedia: number;
  readonly maxImages: number;
  readonly maxVideos: number;
  readonly maxVideoSeconds: number | null;
  readonly maxAltChars: number | null;
  readonly maxTitleChars: number | null;
  readonly supportsThreads: boolean;
  readonly maxThreadParts: number | null;
  readonly maxHashtags: number | null;
  readonly hashtagStyle: HashtagStyle;
  readonly requiresAltText: boolean;
  readonly urlCountsAsChars: number | null;
  readonly mediaRules: Readonly<Record<string, unknown>>;
  /** Live Postiz maxLength from channel_constraint_overrides; null until the
   *  refresh has run — the validator skips its second ceiling then. */
  readonly postizMaxChars: number | null;
  /** The CDN host musebook-public media must be addressed on. */
  readonly cdnHost: string;
}

/** A raw platforms row, snake_case as Postgres returns it. */
export interface PlatformRow {
  readonly slug: string;
  readonly display_name: string;
  readonly max_chars: number;
  readonly count_method: CountMethod;
  readonly editor: PlatformEditor;
  readonly min_media: number;
  readonly max_images: number;
  readonly max_videos: number;
  readonly max_video_seconds: number | null;
  readonly max_alt_chars: number | null;
  readonly max_title_chars: number | null;
  readonly supports_threads: boolean;
  readonly max_thread_parts: number | null;
  readonly max_hashtags: number | null;
  readonly hashtag_style: HashtagStyle;
  readonly requires_alt_text: boolean;
  readonly url_counts_as_chars: number | null;
  readonly media_rules: Record<string, unknown>;
}

export interface ConstraintOverride {
  readonly max_chars: number | null;
  readonly rules_text: string | null;
}

export function toConstraint(
  row: PlatformRow,
  opts: { readonly override?: ConstraintOverride | null; readonly cdnHost: string },
): PlatformConstraint {
  return {
    slug: row.slug,
    displayName: row.display_name,
    maxChars: row.max_chars,
    countMethod: row.count_method,
    editor: row.editor,
    minMedia: row.min_media,
    maxImages: row.max_images,
    maxVideos: row.max_videos,
    maxVideoSeconds: row.max_video_seconds,
    maxAltChars: row.max_alt_chars,
    maxTitleChars: row.max_title_chars,
    supportsThreads: row.supports_threads,
    maxThreadParts: row.max_thread_parts,
    maxHashtags: row.max_hashtags,
    hashtagStyle: row.hashtag_style,
    requiresAltText: row.requires_alt_text,
    urlCountsAsChars: row.url_counts_as_chars,
    mediaRules: row.media_rules,
    postizMaxChars: opts.override?.max_chars ?? null,
    cdnHost: opts.cdnHost,
  };
}
