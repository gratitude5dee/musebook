// apps/web/components/consent/ConsentGate.tsx — §15.10 verbatim (one import
// adjusted: the module here is telemetry/collector, not telemetry/client).
// Two rules it encodes: Decline is the same visual weight as Allow, and
// declining degrades the product to recency ordering, never breaks it.
"use client";

import Link from "next/link";
import { useState } from "react";
import { setTelemetryEnabled } from "@/lib/telemetry/collector";

export function ConsentGate({ initiallyRequired }: { initiallyRequired: boolean }) {
  // §15.10: when the region list says consent is required, telemetry is OFF
  // as the initial state — set here, synchronously, before any child tracker
  // effect can record() into the queue.
  if (initiallyRequired) setTelemetryEnabled(false);
  const [open, setOpen] = useState(initiallyRequired);
  if (!open) return null;

  async function choose(granted: boolean): Promise<void> {
    setTelemetryEnabled(granted);
    // /api/* is a Worker route: this POST never reaches Vercel (§3.6.1).
    await fetch("/api/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "analytics", granted, source: "banner" }),
      keepalive: true,
    });
    setOpen(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4"
    >
      <h2 id="consent-title" className="text-sm font-medium">
        Personalised ranking
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Musebook can use what you read to order your feed. It never uses third-party trackers, never
        stores your IP address, and never sells your reading history. Declining still lets you use
        everything; the feed is ordered by recency instead.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void choose(true)}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          Allow
        </button>
        <button onClick={() => void choose(false)} className="rounded border px-3 py-1.5 text-sm">
          Decline
        </button>
        <Link href="/legal/privacy" className="self-center text-sm underline">
          Privacy policy
        </Link>
      </div>
    </div>
  );
}
