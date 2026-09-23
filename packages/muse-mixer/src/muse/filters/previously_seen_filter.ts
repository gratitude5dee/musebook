// packages/muse-mixer/src/muse/filters/previously_seen_filter.ts
// §9.9 #8 — bloom-backed previously-seen with the >70 % circuit breaker §9.16
// requires. The bloom objects are injected so no library import crosses into src/muse/.
import type { Filter, FilterResult, StatsSink } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";
import type { SeenBloom } from "../bloom.js";

export class PreviouslySeenFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "PreviouslySeenFilter";
  constructor(
    private readonly bloom: SeenBloom | null,
    private readonly prev: SeenBloom | null,
    private readonly bypassRatio: number,
    private readonly stats: StatsSink | null = null,
  ) {}

  filter(_q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (this.bloom === null) return { kept: candidates, removed: [] };
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (this.bloom.has(c.postId) || this.prev?.has(c.postId) === true) {
        removed.push({ candidate: c, reason: "previously_seen_bloom" });
      } else kept.push(c);
    }
    const ratio = candidates.length === 0 ? 0 : removed.length / candidates.length;
    if (ratio > this.bypassRatio) {
      // MUSE_BLOOM_BYPASS_REMOVAL_RATIO = 0.70
      this.stats?.counter("muse.bloom.circuit_breaker_open", 1);
      return { kept: candidates, removed: [] }; // bypass this build entirely and alarm
    }
    return { kept, removed };
  }
}

/** §9.9 #9 — exact backup: the ring buffer of the last MUSE_SEEN_EXACT_WINDOW ids. */
export class PreviouslySeenBackupFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "PreviouslySeenBackupFilter";
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (q.seenIdsExact.length === 0) return { kept: candidates, removed: [] };
    const seen = new Set(q.seenIdsExact);
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (seen.has(c.postId)) removed.push({ candidate: c, reason: "previously_seen_exact" });
      else kept.push(c);
    }
    return { kept, removed };
  }
}

/** §9.9 #10 — blocked/muted creators; degrades CLOSED when the hydrator failed (§9.6). */
export class BlockMuteFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "BlockMuteFilter";
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (!q.blockMuteLoaded) {
      // The safe default is not an empty list — drop every out-of-network candidate.
      const kept = candidates.filter((c) => c.inNetwork === true);
      const removed = candidates
        .filter((c) => c.inNetwork !== true)
        .map((candidate) => ({ candidate, reason: "block_mute_unloaded" }));
      return { kept, removed };
    }
    const blocked = new Set(q.blockedCreatorIds);
    const muted = new Set(q.mutedCreatorIds);
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (blocked.has(c.creatorId)) removed.push({ candidate: c, reason: "blocked_creator" });
      else if (muted.has(c.creatorId)) removed.push({ candidate: c, reason: "muted_creator" });
      else kept.push(c);
    }
    return { kept, removed };
  }
}

/** §9.9 #11 — title/body scan against muted keywords. */
export class MutedKeywordFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "MutedKeywordFilter";
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (q.mutedKeywords.length === 0) return { kept: candidates, removed: [] };
    const needles = q.mutedKeywords.map((k) => k.toLowerCase());
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      const hay = `${c.title ?? ""}\n${c.body ?? ""}`.toLowerCase();
      if (needles.some((k) => k.length > 0 && hay.includes(k))) {
        removed.push({ candidate: c, reason: "muted_keyword" });
      } else kept.push(c);
    }
    return { kept, removed };
  }
}

/** §9.9 #12 — >1 candidate sharing a remixRootId: keep the highest sourceScore. */
export class RemixDedupFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "RemixDedupFilter";
  filter(_q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    const byRoot = new Map<string, MuseCandidate[]>();
    for (const c of candidates) {
      if (c.remixRootId === undefined) continue;
      const g = byRoot.get(c.remixRootId);
      if (g === undefined) byRoot.set(c.remixRootId, [c]);
      else g.push(c);
    }
    if (byRoot.size === 0) return { kept: candidates, removed: [] };
    const drop = new Set<MuseCandidate>();
    for (const group of byRoot.values()) {
      if (group.length < 2) continue;
      const best = group.reduce((a, b) => ((a.sourceScore ?? 0) >= (b.sourceScore ?? 0) ? a : b));
      for (const c of group) if (c !== best) drop.add(c);
    }
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (drop.has(c)) removed.push({ candidate: c, reason: "remix_dedup" });
      else kept.push(c);
    }
    return { kept, removed };
  }
}

/** §9.9 #13 — safety verdict 'drop'. */
export class SafetyDropFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "SafetyDropFilter";
  filter(_q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (c.safety?.verdict === "drop") removed.push({ candidate: c, reason: "safety_drop" });
      else kept.push(c);
    }
    return { kept, removed };
  }
}

/**
 * §9.9 #14 — when actionCount < MuseRetrievalNewUserActionThreshold, drop posts
 * below a minimum engagement floor so a brand-new viewer's first feed is not all
 * zero-signal content.
 */
export class NewUserMinEngagementFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "NewUserMinEngagementFilter";
  constructor(
    private readonly retrievalThreshold: number,
    private readonly minEngagements: number,
  ) {}
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (q.actionCount >= this.retrievalThreshold) return { kept: candidates, removed: [] };
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      const engagements =
        (c.counters?.likes ?? 0) +
        (c.counters?.comments ?? 0) +
        (c.counters?.reposts ?? 0) +
        (c.counters?.bookmarks ?? 0) +
        (c.rolling?.engagements24h ?? 0);
      if (engagements < this.minEngagements) {
        removed.push({ candidate: c, reason: "new_user_min_engagement" });
      } else kept.push(c);
    }
    return { kept, removed };
  }
}

/** §9.9 #R — reels only: anything with no playable rendition (§9.24). */
export class ReelsPlayableFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "ReelsPlayableFilter";
  enable(q: MuseFeedQuery): boolean {
    return q.surface === "reels";
  }
  filter(_q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if ((c.durationMs ?? 0) < 2000 || c.mediaUrl === undefined) {
        removed.push({ candidate: c, reason: "reels_not_playable" });
      } else if (c.mediaStorage !== "r2_public") {
        removed.push({ candidate: c, reason: "reels_not_cdn_servable" });
      } else kept.push(c);
    }
    return { kept, removed };
  }
}
