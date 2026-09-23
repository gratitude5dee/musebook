// packages/muse-mixer/src/muse/filters/index.ts
// §9.9's 14 sequential filters + the reels-only 15th. Order is load-bearing:
// cheap → expensive, each sees only the survivors of the previous.
import type { Filter, FilterResult } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";

function result(
  kept: MuseCandidate[],
  removed: Array<{ candidate: MuseCandidate; reason: string }>,
): FilterResult<MuseCandidate> {
  return { kept, removed };
}

/** 1 — duplicate postId across sources is already merged by the executor; a second guard here. */
export class DropDuplicatesFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "DropDuplicatesFilter";
  filter(_q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    const seen = new Set<string>();
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (seen.has(c.postId)) {
        removed.push({ candidate: c, reason: "duplicate_post" });
      } else {
        seen.add(c.postId);
        kept.push(c);
      }
    }
    return result(kept, removed);
  }
}

/** 2 — candidates CoreDataHydrator could not resolve (deleted mid-flight). */
export class CoreDataHydrationFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "CoreDataHydrationFilter";
  filter(_q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (c.title === undefined) removed.push({ candidate: c, reason: "core_data_missing" });
      else kept.push(c);
    }
    return result(kept, removed);
  }
}

/** 3 — the viewer never sees their own posts. */
export class SelfPostFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "SelfPostFilter";
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (q.viewerId === null) return result(candidates, []);
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (c.creatorId === q.viewerId) removed.push({ candidate: c, reason: "self_post" });
      else kept.push(c);
    }
    return result(kept, removed);
  }
}

/** 4 — 30 d default; 72 h on surface 'home' (params may override). */
export class AgeFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "AgeFilter";
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    const maxAgeMs = q.surface === "home" ? 72 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
    const now = Date.now();
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (now - c.publishedAt > maxAgeMs) removed.push({ candidate: c, reason: "too_old" });
      else kept.push(c);
    }
    return result(kept, removed);
  }
}

/** 5 — kind outside the requested set. */
export class KindFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "KindFilter";
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (q.includeKinds.length === 0) return result(candidates, []);
    const allowed = new Set(q.includeKinds);
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (!allowed.has(c.kind)) removed.push({ candidate: c, reason: "kind_excluded" });
      else kept.push(c);
    }
    return result(kept, removed);
  }
}

/** 6 — any topic in excludedTopicIds. */
export class TopicIdsFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "TopicIdsFilter";
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (q.excludedTopicIds.length === 0) return result(candidates, []);
    const excluded = new Set(q.excludedTopicIds);
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      const topics = c.topics ?? [];
      if (topics.some((t) => excluded.has(t)))
        removed.push({ candidate: c, reason: "topic_excluded" });
      else kept.push(c);
    }
    return result(kept, removed);
  }
}

/** 7 — the posts on the slate this build replaces. */
export class PreviouslyServedFilter implements Filter<MuseFeedQuery, MuseCandidate> {
  readonly name = "PreviouslyServedFilter";
  filter(q: MuseFeedQuery, candidates: MuseCandidate[]): FilterResult<MuseCandidate> {
    if (q.servedIds.length === 0) return result(candidates, []);
    const served = new Set(q.servedIds);
    const kept: MuseCandidate[] = [];
    const removed: Array<{ candidate: MuseCandidate; reason: string }> = [];
    for (const c of candidates) {
      if (served.has(c.postId)) removed.push({ candidate: c, reason: "previously_served" });
      else kept.push(c);
    }
    return result(kept, removed);
  }
}
