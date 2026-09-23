import type { MuseFeedQuery } from "../src/muse/query.js";
import type { MuseCandidate } from "../src/muse/candidate.js";
import type { PostKind, Surface } from "@musebook/schema";

let seq = 0;

export function makeQuery(overrides: Partial<MuseFeedQuery> = {}): MuseFeedQuery {
  const n = ++seq;
  return {
    requestId: `req-${n}`,
    viewerId: "v-1",
    viewerWallet: null,
    viewerKind: "human",
    agentId: null,
    surface: "home" as Surface,
    sessionId: `sess-${n}`,
    limit: 20,
    countryCode: null,
    languageCode: null,
    includeKinds: [],
    topicIds: [],
    excludedTopicIds: [],
    followedCreatorIds: [],
    mutualFollowCreatorIds: [],
    blockedCreatorIds: [],
    mutedCreatorIds: [],
    mutedKeywords: [],
    blockMuteLoaded: true,
    followedTopicIds: [],
    inferredTopicIds: [],
    installedAppIds: [],
    entitlements: { paidContentHashes: [] },
    viewerEmbedding: null,
    seenBloomSerialized: null,
    seenBloomPrevSerialized: null,
    seenIdsExact: [],
    servedIds: [],
    actionCount: 0,
    viewerSubscribed: false,
    recentCreatorIds: [],
    viewerClusterIds: [],
    weightsVersion: "v1",
    modelVersion: "v1.model-heuristic",
    slateId: `slate-${n}`,
    viewerContextVersion: `vcv-${n}`,
    ...overrides,
  };
}

export function makeCandidate(overrides: Partial<MuseCandidate> = {}): MuseCandidate {
  const n = ++seq;
  const kind = (overrides.kind ?? "note") as PostKind;
  return {
    candidateId: overrides.postId ?? `post-${n}`,
    postId: `post-${n}`,
    contentHash: `hash-${n}`,
    kind,
    creatorId: `creator-${(n % 7) + 1}`,
    creatorKind: "human",
    publishedAt: Date.now() - n * 60000,
    sourceNames: ["TestSource"],
    inNetwork: false,
    mutualFollow: false,
    monetization: { mode: "free", priceUsd: null, viewerEntitled: false },
    counters: {
      impressions: 10 + n,
      opens: 4,
      likes: n % 3,
      comments: 0,
      reposts: 0,
      bookmarks: n % 2,
      paidFetches: 0,
      dwellMsTotal: 0,
    },
    rolling: {
      humanImpressions24h: 10,
      humanOpens24h: 4,
      dwellMsP50_24h: 1000,
      dwellMsP90_24h: 3000,
      completionRate24h: 0.5,
      replays24h: 0,
      engagements24h: n % 5,
      agentFetches24h: 0,
      distinctAgents24h: 0,
      signedAgentFetches24h: 0,
      citations7d: 0,
      purchases24h: 0,
      velocity24h: 0.1,
    },
    ...overrides,
  };
}
