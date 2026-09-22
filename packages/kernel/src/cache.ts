// packages/kernel/src/cache.ts — plan.md §6.5, verbatim.
import type { CachePolicy } from "@musebook/schema";

export const PUBLIC_CACHEABLE: CachePolicy = {
  cacheControl: "public, s-maxage=300, stale-while-revalidate=86400",
  vary: ["Accept", "Accept-Encoding"],
  shared: true,
};

export const PUBLIC_CACHEABLE_AGENT_VARY: CachePolicy = {
  cacheControl: "public, s-maxage=300, stale-while-revalidate=86400",
  vary: ["Accept", "Accept-Encoding", "Signature-Agent"],
  shared: true,
};

export const PRIVATE_NO_STORE: CachePolicy = {
  cacheControl: "private, no-store, must-revalidate",
  vary: [],
  shared: false,
};
