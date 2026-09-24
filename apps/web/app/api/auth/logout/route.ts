// apps/web/app/api/auth/logout/route.ts — §5.4 endpoint table: revoke the
// session row, clear the cookie, 204.
export const runtime = "nodejs";

import { cookies } from "next/headers";
import { readSession } from "@/lib/auth/read-session";
import { requireSameOrigin } from "@/lib/auth/csrf";
import { serviceDb } from "@/lib/db/service";
import { audit } from "@/lib/audit";

export async function POST(req: Request) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const s = await readSession(req);
  if (s) {
    await serviceDb
      .from("sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", s.sessionId)
      .is("revoked_at", null);

    await audit({
      actor: "human_creator",
      actor_user_id: s.userId,
      action: "auth.logout",
    });
  }

  (await cookies()).set("__Host-mb_session", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return new Response(null, { status: 204 });
}
