// apps/web/lib/telemetry/collector.ts — §13.4.2 verbatim. Queue, batching,
// transport. The endpoint it posts to is answered by musebook-edge.
"use client";

import type { HumanEvent } from "@musebook/schema";

const ENDPOINT = "/api/events"; // same origin; answered by musebook-edge, never by Vercel
const CHUNK = 16; // matches humanBatchSchema.events.max(16)
const IDLE_FLUSH_MS = 5_000;
const QUEUE_CAP = 256; // hard backstop against a runaway observer

type FlushReason = "full" | "idle" | "hidden" | "pagehide" | "manual";

let queue: HumanEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let enabled = true;

/** Called by the consent surface. Flipping to false discards the queue. */
export function setTelemetryEnabled(next: boolean): void {
  enabled = next;
  if (!next) queue = [];
}

export function record(event: HumanEvent): void {
  if (!enabled) return;
  if (queue.length >= QUEUE_CAP) return;
  queue.push(event);
  if (queue.length >= CHUNK) {
    flush("full");
    return;
  }
  if (timer === null) {
    timer = setTimeout(() => flush("idle"), IDLE_FLUSH_MS);
  }
}

export function flush(reason: FlushReason): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  for (let i = 0; i < events.length; i += CHUNK) {
    send(events.slice(i, i + CHUNK), reason);
  }
}

function send(events: HumanEvent[], reason: FlushReason): void {
  const body = JSON.stringify({ v: 1, sent_at: Date.now(), events });
  const blob = new Blob([body], { type: "application/json" });
  // sendBeacon is fire-and-forget and survives the document being torn down,
  // but its per-origin queue is capped (64 KiB in the spec's recommended
  // minimum) and it returns false when the browser refuses to enqueue.
  if ((reason === "hidden" || reason === "pagehide") && navigator.sendBeacon(ENDPOINT, blob)) {
    return;
  }
  void fetch(ENDPOINT, {
    method: "POST",
    body: blob,
    keepalive: true,
    credentials: "same-origin",
    cache: "no-store",
  }).catch(() => {
    // Telemetry loss must never surface to the reader. Same rule as §7.9.
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush("hidden");
  });
  // `pagehide`, never `unload`: an `unload` listener disqualifies the page
  // from the back/forward cache in Chrome and Safari.
  window.addEventListener("pagehide", () => flush("pagehide"));
}
