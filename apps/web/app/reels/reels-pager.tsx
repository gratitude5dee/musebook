// apps/web/app/reels/reels-pager.tsx — the reels pager (§14.4.10's first cut,
// M6). The full snap-scroll pager with hls.js is 14.4.10; M6 ships the feed
// contract: POST /api/feed/reels, `surface: 'reels'`, paging by returned
// `position` — never by item count.
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SlateProvider } from "@/lib/telemetry/slate-context";
import { useReadTracker } from "@/lib/telemetry/read-tracker";

interface ReelItem {
  position: number;
  post_id: string;
  kind: string;
  slug: string;
  title: string | null;
  content_hash: string;
  published_at: string | null;
  author_user_id: string;
  viewer_entitled: boolean;
}

interface ReelsResponse {
  items: ReelItem[];
  nextCursor: string | null;
  slateId: string;
  stale?: boolean;
  degraded?: boolean;
}

function ReelCard({
  item,
  slateId,
  viewSessionId,
}: {
  item: ReelItem;
  slateId: string;
  viewSessionId: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useReadTracker(ref, {
    postId: item.post_id,
    contentHash: item.content_hash,
    surface: "reels",
    slateId,
    position: item.position,
    viewSessionId,
    isOpen: false,
  });
  return (
    <article
      ref={ref}
      className="flex min-h-[80vh] snap-start flex-col items-center justify-center rounded-lg bg-black p-8 text-white"
    >
      <p className="mb-2 text-xs uppercase tracking-wide opacity-60">{item.kind}</p>
      <h2 className="mb-4 text-xl font-semibold">{item.title ?? item.slug}</h2>
      <Link href={`/p/${item.slug}`} className="rounded-md bg-white/10 px-4 py-2 text-sm">
        Open {item.kind}
      </Link>
    </article>
  );
}

export function ReelsPager() {
  const [items, setItems] = useState<ReelItem[]>([]);
  const [slateId, setSlateId] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [viewSessionId] = useState(() => crypto.randomUUID());

  const load = async (after: string | null): Promise<void> => {
    const res = await fetch("/api/feed/reels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(after === null ? { limit: 10 } : { limit: 10, cursor: after }),
      cache: "no-store",
    });
    if (!res.ok) return;
    const doc = (await res.json()) as ReelsResponse;
    setSlateId(doc.slateId);
    setDegraded(doc.degraded === true);
    setCursor(doc.nextCursor);
    setItems((prev) => (after === null ? doc.items : [...prev, ...doc.items]));
  };

  useEffect(() => {
    void load(null);
  }, []);

  return (
    <main className="mx-auto max-w-[480px] snap-y snap-mandatory space-y-4 px-2 py-6">
      {degraded ? (
        <p className="rounded-md border px-4 py-2 text-sm">
          Showing newest first — personalization is catching up.
        </p>
      ) : null}
      {items.map((item) => (
        <SlateProvider key={item.post_id} slateId={slateId} position={item.position}>
          <ReelCard item={item} slateId={slateId} viewSessionId={viewSessionId} />
        </SlateProvider>
      ))}
      {cursor !== null ? (
        <button className="w-full rounded-md border py-3 text-sm" onClick={() => void load(cursor)}>
          More
        </button>
      ) : null}
      {items.length === 0 ? <p className="py-20 text-center text-sm">Nothing here yet.</p> : null}
    </main>
  );
}
