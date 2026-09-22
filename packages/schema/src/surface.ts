// packages/schema/src/surface.ts
import { z } from "zod";

/** Surfaces a human reader can be on. §9.5's `Surface` is this list.
 *  `reels` is the vertical music/video pager (CF-SPINE §13.1, §4.2, §14).
 *  `following` is §14.4.1's Following tab. */
export const HUMAN_SURFACES = [
  "home",
  "following",
  "explore",
  "apps",
  "topic",
  "author",
  "search",
  "post",
  "profile",
  "artifact",
  "reels",
] as const;

/** Surfaces an agent can be on. `mcp_feed` is what §7.9 writes for a feed
 *  read through an MCP tool; `feed` is the first-party HTTP feed route;
 *  `crawl` is an agent fetching a `.md` / `.json` twin (§2, §5, §6, §13). */
export const AGENT_SURFACES = [
  "mcp",
  "mcp_feed",
  "crawl",
  "http_md",
  "http_json",
  "http_jsonld",
  "http_html",
  "feed",
  "webmcp",
] as const;

export const SURFACES = [...HUMAN_SURFACES, ...AGENT_SURFACES] as const;

export const humanSurfaceSchema = z.enum(HUMAN_SURFACES);
export type HumanSurface = z.infer<typeof humanSurfaceSchema>;

export const agentSurfaceSchema = z.enum(AGENT_SURFACES);
export type AgentSurface = z.infer<typeof agentSurfaceSchema>;

/** `syndicated:<platform>`, where `<platform>` is a `platforms.slug` (§12.3.10).
 *  Open-ended by construction: a new platform must not require a schema release. */
export const SYNDICATED_SURFACE_RE = /^syndicated:[a-z0-9][a-z0-9_-]{1,31}$/;
export const syndicatedSurfaceSchema = z.string().regex(SYNDICATED_SURFACE_RE);

export function isSyndicatedSurface(value: string): boolean {
  return SYNDICATED_SURFACE_RE.test(value);
}

/** The full vocabulary. This is what §4.8's `action_events.surface` column
 *  accepts and what §9.5 imports; the two narrow schemas above are subsets
 *  of it, not second vocabularies. */
export const surfaceSchema = z.union([z.enum(SURFACES), syndicatedSurfaceSchema]);
export type Surface = z.infer<typeof surfaceSchema>;
