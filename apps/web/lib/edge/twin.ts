// apps/web/lib/edge/twin.ts — the ONE module that fetches a twin from
// musebook-edge (§2.4, §14.4.2 step 2). The page's Server Component calls
// fetch(`https://musebook.dev/p/{slug}.json`) carrying `x-musebook-edge` in the
// OTHER direction: the secret proves this hop came from the renderer, not an
// agent that copied the twin URL.
import "server-only";
import { headers } from "next/headers";

export interface TwinEnvelope {
  schema: string;
  post: {
    postId: string;
    slug: string;
    kind: string;
    url: string;
    title: string | null;
    summary: string | null;
    author: { handle: string; displayName: string };
    language: string;
    publishedAt: string | null;
    updatedAt: string;
    tags: string[];
    license: string;
    contentHash: string;
  };
  accessBadge: { kind: "open" | "toll" | "gated"; priceUsd?: string; rule: string };
  body: string | null;
  preview: string | null;
  payment: {
    required: boolean;
    priceAtomic: string;
    priceAsset: string | null;
    priceUsd: string | null;
    priceNetwork: string | null;
  };
  jsonld: Record<string, unknown>;
  paymentRequired?: unknown;
  error?: string;
}

/** Fetches `/p/{slug}.json` on the Worker. The Worker itself always resolves
 *  full access for this hop — it reads `x-musebook-edge` plus the forwarded
 *  `x-mb-plane` — so what comes back is either the full body or `error`. */
export async function fetchJsonTwin(slug: string): Promise<TwinEnvelope | null> {
  // Forward the inbound session cookie: the twin must resolve the SAME actor
  // the outer request did, or an author's own gated post reads as anonymous
  // (402) and the page falls to notFound(). x-musebook-edge authenticates the
  // hop; the cookie carries the actor.
  const cookie = (await headers()).get("cookie") ?? "";
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://musebook.dev";
  const secret = process.env.MUSEBOOK_EDGE_SECRET;
  if (secret === undefined) {
    throw new Error("MUSEBOOK_EDGE_SECRET is required for twin fetches (§14.5.4)");
  }
  const res = await fetch(`${base}/p/${encodeURIComponent(slug)}.json`, {
    headers: { "x-musebook-edge": secret, cookie },
    // Twin responses are `private, no-store` when negotiated — but the fetch
    // cache keys on Next's data cache, and the Worker's `.json` route serves
    // fresh content for each content hash, so a zero revalidate keeps the page
    // inside ISR without ever serving a stale hash.
    next: { revalidate: 0 },
  });
  if (!res.ok) return null;
  const doc = (await res.json()) as TwinEnvelope;
  return doc.error !== undefined ? null : doc;
}
