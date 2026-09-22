// apps/web/app/api/agent/delegations/[id]/route.ts — §10.7.5.
// One RPC. After it commits the delegation is dead, every hold is cancelled,
// every pending approval is rejected, and every far-side cancel is a durable
// outbox row. This route has NO Queues binding and needs none: the * * * * *
// sweeper in musebook-worker picks the rows up within ~60 seconds.
export const runtime = "nodejs";

import { readSession } from "@/lib/auth/read-session";
import { requireSameOrigin } from "@/lib/auth/csrf";
import { serviceDb } from "@/lib/db/service";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const session = await readSession(req); // §5.6.1: a users row, not an Actor
  if (!session) {
    return Response.json({ error: "human_session_required" }, { status: 403 });
  }

  // revoke_delegation is SECURITY DEFINER and bypasses RLS — the ownership check
  // is this caller's contract, verified against the owner column before the call.
  const { data: d } = await serviceDb
    .from("delegations")
    .select("id, owner_user_id")
    .eq("id", id)
    .maybeSingle();
  if (!d || d.owner_user_id !== session.userId) {
    return Response.json({ error: "delegation_not_found" }, { status: 404 });
  }

  await serviceDb.rpc("revoke_delegation", {
    p_delegation_id: id,
    p_reason: "owner_revoked",
    p_actor_user_id: session.userId,
  });

  return new Response(null, { status: 204 });
}
