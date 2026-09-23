import type { PostKind, Surface } from "@musebook/schema";
import type { ViewerSequence } from "../framework/ports.js";
import type { ViewerContext } from "./scorers/muse_scorer.js";
import type { PipelineQuery } from "../framework/types.js";

export type ViewerKind = "human" | "agent";

export interface MuseCursor {
  slateId: string;
  offset: number;
  weightsVersion: string;
}

export interface MuseFeedQuery extends PipelineQuery {
  // ---- build-time inputs. A slate build is started either by the hourly Cron handler
  //      (which reads the viewer set from the database) or by musebook-edge over a
  //      Service Binding, which passes the resolved actor and the geo/locale it already
  //      read from `request.cf` — see the note under this block.
  viewerId: string | null; // users.id; null for an anonymous or agent viewer
  viewerWallet: string | null; // lowercased 0x…
  viewerKind: ViewerKind;
  agentId: string | null; // agent_identities.id when viewerKind === 'agent'
  surface: Surface; // 'home' | 'reels' | 'explore' | … (§13.3)
  sessionId: string;
  limit: number;
  countryCode: string | null;
  languageCode: string | null;
  includeKinds: PostKind[];
  topicIds: string[]; // post_classifications.topics values (§8.7)
  excludedTopicIds: string[];
  // ---- hydrated by QueryHydrators (defaults below are what a failed hydrator leaves in place)
  followedCreatorIds: string[];
  mutualFollowCreatorIds: string[];
  blockedCreatorIds: string[];
  mutedCreatorIds: string[];
  mutedKeywords: string[];
  blockMuteLoaded: boolean; // §9.6: BlockMuteFilter degrades closed when false
  followedTopicIds: string[];
  inferredTopicIds: string[];
  installedAppIds: string[];
  entitlements: { paidContentHashes: string[] };
  viewerEmbedding: number[] | null; // 1536, from user_embeddings
  seenBloomSerialized: string | null;
  seenBloomPrevSerialized: string | null;
  seenIdsExact: string[]; // last MUSE_SEEN_EXACT_WINDOW served ids
  servedIds: string[]; // post ids on the slate this one replaces
  actionCount: number; // drives BOTH new-user thresholds independently
  // ---- internal sequence handles, set by the §9.6 sequence hydrators
  viewerSequence?: ViewerSequence | null; // ScoringSequenceQueryHydrator
  retrievalSequence?: ViewerSequence | null; // RetrievalSequenceQueryHydrator
  // ---- resolved config, logged on every slate
  weightsVersion: string;
  modelVersion: string;
  slateId: string; // uuid, generated before the pass runs; slates.id
  viewerContextVersion: string; // logged into slates.params; the warm-start key (§9.11)
  // ---- internal, set by ScoringSequenceQueryHydrator; MuseScorer derives it when absent
  viewerContext?: ViewerContext;
}
