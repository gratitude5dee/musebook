// apps/web/lib/telemetry/media-tracker.ts — §13.4.2 verbatim. play (first and
// replays), play_through, quartile progress. §13.7.3's media_plays/replays
// counts read client->'media'->>'play_index' — meaningless without this.
"use client";

import { useEffect, useRef } from "react";
import type { HumanEvent } from "@musebook/schema";
import { record } from "./collector";
import type { ReadTrackerInput } from "./read-tracker";

const MAX_REPLAYS = 3;
/** Section 9's definition of the play_through head: >= 85 % consumed, or `ended`. */
const PLAY_THROUGH_PCT = 85;

/** Furthest quartile reached, per (view_session_id, post_id). useReadTracker
 *  takes it at teardown so the terminal `dwell` row of a media post carries
 *  `completion_pct`. Module-level on purpose: the two hooks share a card but
 *  must not share refs, and a card can hold more than one asset (the maximum
 *  across assets is what the retention curve wants). */
const progress = new Map<string, number>();
const progressKey = (viewSessionId: string, postId: string): string => `${viewSessionId}:${postId}`;

export function takeMediaCompletion(viewSessionId: string, postId: string): number | undefined {
  const key = progressKey(viewSessionId, postId);
  const pct = progress.get(key);
  progress.delete(key);
  return pct;
}

function noteProgress(key: string, pct: number): void {
  if ((progress.get(key) ?? 0) < pct) progress.set(key, pct);
}

export function useMediaTracker(
  ref: React.RefObject<HTMLMediaElement | null>,
  input: ReadTrackerInput & { assetId: string },
): void {
  const playIndex = useRef(0);
  const watchedMs = useRef(0);
  const lastTime = useRef(0);
  const playedThrough = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const key = progressKey(input.viewSessionId, input.postId);

    const base = (action: HumanEvent["action"]): HumanEvent => ({
      event_id: crypto.randomUUID(),
      t: Date.now(),
      action,
      post_id: input.postId,
      content_hash: input.contentHash,
      surface: input.surface,
      slate_id: input.slateId,
      position: input.position,
      view_session_id: input.viewSessionId,
      media: {
        asset_id: input.assetId,
        watched_ms: Math.round(watchedMs.current),
        duration_ms: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : undefined,
        play_index: playIndex.current,
        muted: el.muted,
      },
    });

    // The first play and up to MAX_REPLAYS replays are each one `play` row,
    // told apart by media.play_index (0 = first play). Beyond the cap, silence:
    // a looping autoplay must not manufacture rows. This matters more on the
    // `reels` surface (§14), where autoplay is the default interaction.
    const onPlay = (): void => {
      if (playIndex.current <= MAX_REPLAYS) record(base("play"));
      playIndex.current += 1;
      lastTime.current = el.currentTime;
    };

    const playThrough = (pct: number): void => {
      if (playedThrough.current) return;
      playedThrough.current = true;
      noteProgress(key, 100);
      record({ ...base("play_through"), completion_pct: pct });
    };

    const onTimeUpdate = (): void => {
      const delta = el.currentTime - lastTime.current;
      // A positive delta under 1.5 s is genuine playback; anything else is a seek.
      if (delta > 0 && delta < 1.5) watchedMs.current += delta * 1000;
      lastTime.current = el.currentTime;

      if (!Number.isFinite(el.duration) || el.duration <= 0) return;
      const pct = (el.currentTime / el.duration) * 100;
      // Quartiles are progress, not events. They ride out on the dwell row.
      for (const q of [25, 50, 75] as const) {
        if (pct >= q) noteProgress(key, q);
      }
      if (pct >= PLAY_THROUGH_PCT) playThrough(Math.min(100, Math.round(pct)));
    };

    const onEnded = (): void => playThrough(100);

    el.addEventListener("play", onPlay);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("ended", onEnded);
    };
  }, [
    ref,
    input.assetId,
    input.postId,
    input.contentHash,
    input.surface,
    input.slateId,
    input.position,
    input.viewSessionId,
  ]);
}
