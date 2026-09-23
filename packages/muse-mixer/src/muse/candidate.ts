import type { PostKind, PublishMode } from "@musebook/schema";
import type { PipelineCandidate } from "../framework/types.js";
import type { MuseAction, MuseContinuous } from "./actions.js";

export interface MuseCandidate extends PipelineCandidate {
  postId: string; // candidateId === postId
  contentHash: string; // spine invariant 1 — the score-reuse key
  kind: PostKind;
  creatorId: string; // posts.author_user_id
  creatorKind: "human" | "agent"; // posts.posted_by_agent_id is null ? 'human' : 'agent'
  publishedAt: number; // posts.published_at, epoch ms
  sourceNames: string[];
  sourceScore?: number; // e.g. cosine similarity from EmbeddingRetrievalSource
  // ---- hydrated
  title?: string;
  summary?: string;
  body?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  durationMs?: number; // assets.duration_ms (§4.4) — the reels gate
  width?: number;
  height?: number;
  mediaStorage?: "r2_public" | "r2_paid" | "r2_artifacts"; // assets.storage
  languageCode?: string;
  topics?: string[]; // post_classifications.topics
  primaryTopic?: string | null;
  taxonomyLeaf?: string | null;
  taxonomyPath?: string[];
  topicProbabilities?: Record<string, number>;
  classification?: {
    quality: number | null;
    qAgentValue: number | null;
    pUnsafe: number | null;
    toxicity: number | null;
    isNsfw: boolean;
  };
  safety?: { verdict: "show" | "soften" | "drop"; categories: string[] };
  postedByAgentId?: string;
  agentProvenance?: { agentId: string; verification: string; isBlocked: boolean };
  monetization?: { mode: PublishMode; priceUsd: string | null; viewerEntitled: boolean };
  app?: {
    appId: string;
    runtime: "2d" | "3d" | "mcp";
    installs: number;
    forks: number;
    viewerInstalled: boolean;
  };
  remixOf?: string;
  remixRootId?: string;
  inNetwork?: boolean;
  mutualFollow?: boolean;
  creatorFollowers?: number;
  counters?: {
    impressions: number;
    opens: number;
    likes: number;
    comments: number;
    reposts: number;
    bookmarks: number;
    paidFetches: number;
    dwellMsTotal: number;
  }; // post_counters (§4.4)
  // post_stats_rolling (§13.7.2) — names track the columns one-for-one
  rolling?: {
    humanImpressions24h: number;
    humanOpens24h: number;
    dwellMsP50_24h: number;
    dwellMsP90_24h: number;
    completionRate24h: number;
    replays24h: number;
    engagements24h: number;
    agentFetches24h: number;
    distinctAgents24h: number;
    signedAgentFetches24h: number;
    citations7d: number;
    purchases24h: number;
    velocity24h: number;
  };
  embedding?: number[]; // hydrated only when MUSE_DIVERSITY_IMPL = 'mmr'
  // ---- THREE DISTINCT SCORES. Do not conflate. Do not collapse into one field.
  actionScores?: Partial<Record<MuseAction, number>>; // per-action probabilities [0,1]  REUSABLE
  continuousPreds?: Partial<Record<MuseContinuous, number>>; //                                 REUSABLE
  weightedScore?: number; // runtime-weighted linear combo   REUSABLE
  weightsVersion?: string; // `${version}/${cohort}` — slate_items + action_events
  score?: number; // after watch-time, cold start, diversity
  debug?: Record<string, number>;
}
