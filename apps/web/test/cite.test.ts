// GATE M18.6 (agent plane) — POST /api/cite trusts x-mb-actor only off an
// edge-authenticated hop, then writes exactly one citations row bound to
// content_hash plus one agent_cite action_events row (purity: actor_agent_id
// set, all human fields null).
import { execSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

// server-only throws under vitest; the route's modules import it transitively.
vi.mock("server-only", () => ({}));

const EDGE_SECRET = "m18-cite-edge-secret";
const AGENT_ID = "00000000-0000-4000-8000-000000000001"; // seed agent identity

const supabaseSecret = (): string => {
  if (process.env.SUPABASE_SECRET_KEY) return process.env.SUPABASE_SECRET_KEY;
  const out = execSync("pnpm exec supabase status -o env", { encoding: "utf8" });
  const m = /^SECRET_KEY="([^"]+)"/m.exec(out);
  if (m?.[1] === undefined) throw new Error("supabase status -o env: SECRET_KEY not found");
  return m[1];
};

let db: ReturnType<typeof createClient>;
let post: { id: string; content_hash: string } | null = null;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SECRET_KEY", supabaseSecret());
  vi.stubEnv("MUSEBOOK_EDGE_SECRET", EDGE_SECRET);
  db = createClient("http://127.0.0.1:54321", supabaseSecret(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await db
    .from("posts")
    .select("id, content_hash")
    .eq("slug", "seed-article-free")
    .single();
  post = data;
});

const citeReq = (headers: Record<string, string>) =>
  new Request("https://musebook.dev/api/cite", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      post_id: post!.id,
      content_hash: post!.content_hash,
      quote: "an agent excerpt",
      char_start: 0,
      char_end: 17,
      surface: "mcp",
    }),
  });

describe("POST /api/cite", () => {
  it("writes one citations row and one agent_cite event for an edge-resolved agent", async () => {
    expect(post).not.toBeNull();
    const { POST } = await import("../app/api/cite/route");
    const res = await POST(
      citeReq({
        "x-musebook-edge": EDGE_SECRET,
        "x-mb-actor": JSON.stringify({ plane: "agent", userId: null, agentIdentityId: AGENT_ID }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { citation_id: string };

    const { data: cites } = await db
      .from("citations")
      .select("id, content_hash, agent_id")
      .eq("id", body.citation_id)
      .returns<{ id: string; content_hash: string; agent_id: string | null }[]>();
    expect(cites).toHaveLength(1);
    expect(cites![0]!.content_hash).toBe(post!.content_hash);
    expect(cites![0]!.agent_id).toBe(AGENT_ID);

    const { data: events } = await db
      // eslint-disable-next-line musebook/no-action-events-at-serve-time -- asserting the M18.6 row the cite path wrote
      .from("action_events")
      .select("action, actor_plane, actor_agent_id, viewer_user_id, mcp_tool, comment_id, content_hash")
      .eq("comment_id", body.citation_id)
      .returns<
        {
          action: string;
          actor_plane: string;
          actor_agent_id: string | null;
          viewer_user_id: string | null;
          mcp_tool: string | null;
          comment_id: string | null;
          content_hash: string | null;
        }[]
      >();
    expect(events).toHaveLength(1);
    expect(events![0]).toMatchObject({
      action: "agent_cite",
      actor_plane: "agent",
      actor_agent_id: AGENT_ID,
      viewer_user_id: null,
      mcp_tool: "cite_passage",
      comment_id: body.citation_id,
      content_hash: post!.content_hash,
    });
  });

  it("ignores a forged x-mb-actor on an unauthenticated hop", async () => {
    const { POST } = await import("../app/api/cite/route");
    const res = await POST(
      citeReq({
        "x-musebook-edge": "wrong",
        "x-mb-actor": JSON.stringify({ plane: "agent", userId: null, agentIdentityId: AGENT_ID }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
