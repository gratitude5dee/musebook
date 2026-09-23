// packages/connectors/src/capabilities.ts — §10.3
import type { Scope } from "@musebook/schema"; // (typeof ALL_SCOPES)[number], §5.7.3

export const CAPABILITIES = [
  "post.draft",
  "post.publish",
  "post.comment",
  "graph.write",
  "media.generate",
  "channel.connect",
  "distribution.publish",
  "feed.read",
  "analytics.read",
  "wallet.spend",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Capability (what a connector advertises) -> scope (what §5.7.3 enforces).
 * A capability is marketing copy on a tile. A scope is a row in delegations.scopes
 * and a branch in requireScope(). They are deliberately different vocabularies
 * so a manifest can never invent an authorization primitive.
 */
export const CAPABILITY_SCOPES: Readonly<Record<Capability, readonly Scope[]>> = {
  "post.draft": ["post:read", "post:write"],
  "post.publish": ["post:write", "post:publish"],
  "post.comment": ["comment:write"],
  "graph.write": ["graph:write"],
  "media.generate": ["media:generate"],
  "channel.connect": ["channel:connect"],
  "distribution.publish": ["distribution:publish"],
  "feed.read": ["feed:read"],
  "analytics.read": ["analytics:read"],
  "wallet.spend": ["wallet:spend"],
} as const;

export function scopesForCapabilities(caps: readonly Capability[]): Scope[] {
  return [...new Set(caps.flatMap((c) => CAPABILITY_SCOPES[c]))].sort();
}
