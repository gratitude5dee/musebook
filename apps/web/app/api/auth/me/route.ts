// apps/web/app/api/auth/me/route.ts — §5.4 endpoint table: the current
// session's identity, or 401.
export const runtime = "nodejs";

import { readSession } from "@/lib/auth/read-session";
import { serviceDb } from "@/lib/db/service";

export async function GET(req: Request) {
  const s = await readSession(req);
  if (!s) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const { data: wallets } = await serviceDb
    .from("wallets")
    .select("address, is_primary")
    .eq("user_id", s.userId);

  return Response.json(
    {
      userId: s.userId,
      handle: s.handle,
      wallets: wallets ?? [],
      class: "human_creator",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
