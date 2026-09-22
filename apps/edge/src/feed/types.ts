// apps/edge/src/feed/types.ts — the wire shapes §9.21 declares.
import type { Surface } from "@musebook/schema";

export interface FeedCursor {
  slateId: string;
  offset: number;
  weightsVersion: string;
}

export interface FeedRequest {
  surface: Surface;
  cursor?: FeedCursor | null;
  limit: number;
  country: string;
}

/** The item shape app.read_slate emits; the R2 keyset page projects the same. */
export interface SlateItem {
  position: number;
  post_id: string;
  source: string;
  score: number | null;
  content_hash: string;
  kind: string;
  slug: string;
  title: string | null;
  published_at: string | null;
  author_user_id: string;
  creator_is_agent: boolean;
  viewer_entitled: boolean;
}

export interface SlateDoc {
  slate_id: string;
  surface: string;
  weights_version: string;
  model_version: string;
  created_at: string;
  expires_at: string;
  candidate_count: number;
  items: SlateItem[];
}

export interface FeedResponse {
  items: SlateItem[];
  nextCursor: string | null;
  slateId: string | null;
  stale?: boolean;
  degraded?: boolean;
  debug?: Record<string, unknown>;
}
