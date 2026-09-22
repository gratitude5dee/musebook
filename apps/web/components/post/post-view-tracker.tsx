// apps/web/components/post/post-view-tracker.tsx — mounts useReadTracker on
// the post page's article element: view on open (isOpen), impression when
// ≥50% visible ≥1s, dwell at teardown with max_scroll_pct.
"use client";

import { useMemo, useRef, type ReactNode } from "react";
import { useReadTracker } from "@/lib/telemetry/read-tracker";

export function PostViewTracker({
  postId,
  contentHash,
  slateId,
  position,
  children,
}: {
  postId: string;
  contentHash: string;
  slateId: string;
  position: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const viewSessionId = useMemo(() => crypto.randomUUID(), []);
  useReadTracker(ref, {
    postId,
    contentHash,
    surface: "post",
    slateId,
    position,
    viewSessionId,
    isOpen: true,
  });
  return <article ref={ref}>{children}</article>;
}
