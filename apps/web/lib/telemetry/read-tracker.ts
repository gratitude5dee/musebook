// apps/web/lib/telemetry/read-tracker.ts — §13.4.2 verbatim. Impression,
// view, dwell (+ scroll depth, media completion).
"use client";

import { useEffect, useRef } from "react";
import type { HumanEvent, HumanSurface } from "@musebook/schema";
import { record, flush } from "./collector";
import { takeMediaCompletion } from "./media-tracker";

export interface SlateCoords {
  slateId: string;
  position: number;
}

export interface ReadTrackerInput extends SlateCoords {
  postId: string;
  contentHash: string;
  surface: HumanSurface;
  viewSessionId: string;
  /** true on /p/{slug}; emits `view` immediately and tracks scroll sentinels. */
  isOpen: boolean;
}

const IMPRESSION_VISIBLE_MS = 1_000;
const IMPRESSION_RATIO = 0.5;

export function useReadTracker(
  ref: React.RefObject<HTMLElement | null>,
  input: ReadTrackerInput,
): void {
  const dwellMs = useRef(0);
  const visibleSince = useRef<number | null>(null);
  const impressionSent = useRef(false);
  const maxScrollPct = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

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
    });

    const startClock = (): void => {
      if (visibleSince.current === null) visibleSince.current = performance.now();
    };
    const stopClock = (): void => {
      if (visibleSince.current !== null) {
        dwellMs.current += Math.round(performance.now() - visibleSince.current);
        visibleSince.current = null;
      }
    };

    let impressionTimer: ReturnType<typeof setTimeout> | null = null;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const attentive =
            entry.intersectionRatio >= IMPRESSION_RATIO &&
            document.visibilityState === "visible" &&
            document.hasFocus();

          if (attentive) {
            startClock();
            if (!impressionSent.current && impressionTimer === null) {
              impressionTimer = setTimeout(() => {
                impressionSent.current = true;
                record(base("impression"));
              }, IMPRESSION_VISIBLE_MS);
            }
          } else {
            stopClock();
            if (impressionTimer !== null) {
              clearTimeout(impressionTimer);
              impressionTimer = null;
            }
          }

          if (input.isOpen) {
            const rect = entry.boundingClientRect;
            const height = rect.height || 1;
            const read = Math.min(Math.max(-rect.top, 0) + window.innerHeight, height);
            const pct = Math.min(100, Math.round((read / height) * 100));
            // Scroll depth is a field on the terminal dwell row, never a row
            // of its own: post_stats_daily.scroll_completes counts dwell rows
            // with max_scroll_pct >= 90.
            if (pct > maxScrollPct.current) maxScrollPct.current = pct;
          }
        }
      },
      { threshold: [0, 0.25, IMPRESSION_RATIO, 0.9, 1] },
    );

    io.observe(el);

    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") stopClock();
      else startClock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", stopClock);
    window.addEventListener("focus", startClock);

    if (input.isOpen) record(base("view"));

    return () => {
      stopClock();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", stopClock);
      window.removeEventListener("focus", startClock);
      if (impressionTimer !== null) clearTimeout(impressionTimer);
      // Terminal dwell row. Below 500 ms is noise, not a read. For a media
      // post it also carries the furthest quartile the media tracker saw.
      if (dwellMs.current >= 500) {
        record({
          ...base("dwell"),
          dwell_ms: Math.min(dwellMs.current, 3_600_000),
          max_scroll_pct: maxScrollPct.current || undefined,
          completion_pct: takeMediaCompletion(input.viewSessionId, input.postId),
        });
        flush("manual");
      }
    };
  }, [
    ref,
    input.postId,
    input.contentHash,
    input.surface,
    input.slateId,
    input.position,
    input.viewSessionId,
    input.isOpen,
  ]);
}
