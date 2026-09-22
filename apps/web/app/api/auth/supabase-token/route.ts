// apps/web/app/api/auth/supabase-token/route.ts — §5.4.3 verbatim.
export const runtime = "nodejs";

import { SignJWT } from "jose";
import { readSession } from "@/lib/auth/read-session";

const TTL_SECONDS = 600;

export async function GET(req: Request) {
  // readSession resolves the mb_session cookie through PostgREST and returns a
  // users row. It is NOT resolveActor: no Actor is constructed on this plane,
  // and a bearer token is never accepted here (§5.4.3).
  const s = await readSession(req);
  if (!s) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
  const token = await new SignJWT({
    role: "authenticated",
    wallet_address: s.primaryWalletAddress ?? undefined,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(s.userId)
    .setAudience("authenticated")
    .setIssuer(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret);

  return Response.json(
    { token, expiresAt: Date.now() + TTL_SECONDS * 1000 },
    { headers: { "cache-control": "no-store" } },
  );
}
