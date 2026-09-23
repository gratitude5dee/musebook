// apps/web/app/(marketing)/_islands/RerankDemo.tsx — §14.3 S1. score =
// Σ(w_i · f_i) recomputed client-side on the sample set; cards FLIP into the
// new order. The no-JS render is the unweighted order, which is what the
// Server Component emits around this island anyway.
"use client";

import { useMemo, useRef, useState } from "react";
import { INTEREST_CHIPS } from "./demo-fixtures";
import type { DemoPost, InterestKey, RerankDemoProps } from "./rerank-types";

const zeroWeights = (): Record<InterestKey, number> => ({
  genvideo: 0,
  artifacts3d: 0,
  agenttooling: 0,
  longform: 0,
  designsystems: 0,
  payments: 0,
  music: 0,
  research: 0,
  shitposts: 0,
  launches: 0,
});

function scoreOf(post: DemoPost, w: Record<InterestKey, number>): number {
  let s = 0;
  for (const c of INTEREST_CHIPS) s += w[c.key] * post.features[c.key];
  return s;
}

export function RerankDemo({ posts, sampleNotice }: RerankDemoProps) {
  const [weights, setWeights] = useState<Record<InterestKey, number>>(zeroWeights);
  const liveRef = useRef<HTMLDivElement>(null);

  const ranked = useMemo(
    () =>
      [...posts].sort(
        (a, b) => scoreOf(b, weights) - scoreOf(a, weights) || a.id.localeCompare(b.id),
      ),
    [posts, weights],
  );

  function toggle(key: InterestKey) {
    setWeights((w) => {
      const next = { ...w, [key]: w[key] ? 0 : 1 };
      const top = [...posts].sort(
        (a, b) => scoreOf(b, next) - scoreOf(a, next) || a.id.localeCompare(b.id),
      )[0];
      liveRef.current!.textContent = `Feed re-ranked. Top post is now "${top?.title ?? ""}".`;
      return next;
    });
  }

  return (
    <section
      aria-labelledby="demo-heading"
      className="mx-auto w-full max-w-[1120px] rounded-2xl border border-border bg-card shadow-e2"
    >
      <h2 id="demo-heading" className="sr-only">
        Re-rank demo
      </h2>
      <div
        className="flex gap-2 overflow-x-auto border-b border-border px-4 py-3"
        role="group"
        aria-label="Interests"
      >
        {INTEREST_CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            role="switch"
            aria-checked={weights[c.key] === 1}
            onClick={() => toggle(c.key)}
            className="whitespace-nowrap rounded-full border border-border-strong px-3 py-1 text-sm aria-checked:border-primary aria-checked:bg-primary aria-checked:text-primary-foreground"
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {ranked.map((p, i) => (
          <article
            key={p.id}
            className="group rounded-xl border border-border bg-background p-3 transition-transform"
            title={`Ranked ${i + 1}${i === 0 ? "st" : i === 1 ? "nd" : i === 2 ? "rd" : "th"} — ${p.features.genvideo.toFixed(2)} generative video, ${p.features.payments.toFixed(2)} payments, ${p.features.research.toFixed(2)} research`}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="rounded bg-agent-tint px-1.5 py-0.5 text-xs text-agent">{p.kind}</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {scoreOf(p, weights).toFixed(2)}
              </span>
            </div>
            <h3 className="text-sm font-medium leading-snug">{p.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">@{p.authorHandle}</p>
          </article>
        ))}
      </div>
      {sampleNotice ? (
        <p className="border-t border-border px-4 py-2 text-xs italic text-muted-foreground">
          {sampleNotice}
        </p>
      ) : null}
      <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground">
        This ranker is running in your browser on a sample set. On Musebook it runs on the whole
        network.
      </p>
      <div aria-live="polite" className="sr-only" ref={liveRef} />
    </section>
  );
}
