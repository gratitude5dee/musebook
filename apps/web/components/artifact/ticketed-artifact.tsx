// apps/web/components/artifact/ticketed-artifact.tsx — the §11.18 client arm.
// A paid artifact's URL is minted per-viewer by the edge route and lives 300
// seconds; the frame renders only after the ticket arrives.
"use client";

import { useEffect, useState } from "react";
import { ArtifactFrame } from "@musebook/ui";

export function TicketedArtifact({ artifactId, title }: { artifactId: string; title: string }) {
  const [state, setState] = useState<{ url?: string | undefined; error?: string | undefined }>({});

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/artifacts/${artifactId}/ticket`, { method: "POST" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setState({ error: `Ticket request failed (${res.status})` });
          return;
        }
        const json = (await res.json()) as { url?: string };
        setState({ url: json.url });
      })
      .catch(() => {
        if (!cancelled) setState({ error: "Ticket request failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  if (state.error !== undefined) {
    return (
      <div className="flex h-full items-center justify-center rounded border border-neutral-800 text-sm text-neutral-400">
        {state.error}
      </div>
    );
  }
  if (state.url === undefined) {
    return (
      <div className="flex h-full items-center justify-center rounded border border-neutral-800 text-sm text-neutral-500">
        Minting access…
      </div>
    );
  }
  return <ArtifactFrame src={state.url} title={title} />;
}
