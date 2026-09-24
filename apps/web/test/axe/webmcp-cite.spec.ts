// GATE M18.6 + M18.7 — cite_passage's server half end-to-end through the edge.
// Allowed: exactly one citations row bound to content_hash + one agent_cite
// action_events row. Denied: the edge's resolveAccess returns 402 with zero
// passage bytes and nothing is written.
import { test, expect } from "@playwright/test";
import { EDGE_ORIGIN, SEED_COOKIE, supabaseSecret } from "./playwright.config";

const REST = "http://127.0.0.1:54321/rest/v1";
const svc = () => ({
  apikey: supabaseSecret(),
  Authorization: `Bearer ${supabaseSecret()}`,
});

type PostRow = { id: string; slug: string; content_hash: string };
type CitationRow = { id: string; post_id: string; content_hash: string };
type EventRow = {
  event_id: string;
  action: string;
  actor_plane: string;
  comment_id: string | null;
  mcp_tool: string | null;
  viewer_user_id: string | null;
  actor_agent_id: string | null;
};

const post = async (slug: string): Promise<PostRow> => {
  const r = await fetch(`${REST}/posts?slug=eq.${slug}&select=id,slug,content_hash`, {
    headers: svc(),
  });
  const rows = (await r.json()) as PostRow[];
  expect(rows.length).toBe(1);
  return rows[0]!;
};

test("M18.6: an allowed cite writes one citations row and one agent_cite event", async ({
  request,
}) => {
  const p = await post("seed-article-free");
  const res = await request.post(`${EDGE_ORIGIN}/api/cite`, {
    headers: { "content-type": "application/json", cookie: SEED_COOKIE },
    data: {
      post_id: p.id,
      content_hash: p.content_hash,
      quote: "a short excerpt",
      char_start: 0,
      char_end: 15,
      surface: "webmcp",
    },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { citation: string; citation_id: string };
  expect(body.citation.length).toBeGreaterThan(0);

  // Exactly one citations row, bound to the content_hash that was read.
  const cites = (await (
    await fetch(`${REST}/citations?id=eq.${body.citation_id}&select=id,post_id,content_hash`, {
      headers: svc(),
    })
  ).json()) as CitationRow[];
  expect(cites.length).toBe(1);
  expect(cites[0]!.post_id).toBe(p.id);
  expect(cites[0]!.content_hash).toBe(p.content_hash);

  // Exactly one agent_cite action_events row pointing at the citation.
  const events = (await (
    await fetch(
      // eslint-disable-next-line musebook/no-action-events-at-serve-time -- verifying the M18.6 row the cite path wrote
      `${REST}/action_events?comment_id=eq.${body.citation_id}&action=eq.agent_cite&select=event_id,action,actor_plane,comment_id,mcp_tool,viewer_user_id,actor_agent_id`,
      { headers: svc() },
    )
  ).json()) as EventRow[];
  expect(events.length).toBe(1);
  expect(events[0]!.actor_plane).toBe("human");
  expect(events[0]!.viewer_user_id).not.toBeNull();
});

test("M18.7: a cite against an ungranted post returns 402 and zero passage bytes", async ({
  request,
}) => {
  const p = await post("seed-article-x402");
  const res = await request.post(`${EDGE_ORIGIN}/api/cite`, {
    headers: { "content-type": "application/json" },
    data: {
      post_id: p.id,
      content_hash: p.content_hash,
      quote: "MUSEBOOK_PAID_BODY_MARKER_7f3a",
      surface: "webmcp",
    },
  });
  expect(res.status()).toBe(402);
  const body = await res.text();
  // Zero passage bytes: neither the paid-body marker nor the quote is echoed.
  expect(body).not.toContain("MUSEBOOK_PAID_BODY_MARKER_7f3a");

  // And nothing was written for that post.
  const cites = (await (
    await fetch(`${REST}/citations?post_id=eq.${p.id}&select=id`, { headers: svc() })
  ).json()) as CitationRow[];
  expect(cites.length).toBe(0);
});
