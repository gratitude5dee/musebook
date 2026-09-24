// apps/web/app/api/posts/[postId]/questions/route.ts — §7.17 ask_author's
// backing route; the comment box's server half. A top-level comments row
// (depth 0, no parent) keyed to the post's content_hash so the question is
// bound to the bytes the reader answered.
export const runtime = "nodejs";

import { z } from "zod";
import { readSession } from "@/lib/auth/read-session";
import { requireSameOrigin } from "@/lib/auth/csrf";
import { serviceDb } from "@/lib/db/service";

const Body = z.object({
  question: z.string().min(1).max(1000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const session = await readSession(req);
  if (!session) return Response.json({ error: "sign_in_required" }, { status: 401 });

  const { postId } = await params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }

  const { data: post } = await serviceDb
    .from("posts")
    .select("id, content_hash")
    .eq("id", postId)
    .maybeSingle()
    .returns<{ id: string; content_hash: string }>();
  if (post === null) return Response.json({ error: "not_found" }, { status: 404 });

  const { error } = await serviceDb.from("comments").insert({
    post_id: post.id,
    content_hash: post.content_hash,
    author_user_id: session.userId,
    body_markdown: parsed.data.question,
  });
  if (error) return Response.json({ error: "question_failed" }, { status: 500 });
  return Response.json({ ok: true });
}
