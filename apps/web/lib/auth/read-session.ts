// apps/web/lib/auth/read-session.ts — resolves the __Host-mb_session cookie to a users
// row over PostgREST. It is NOT resolveActor: no Actor is constructed on this
// plane, and Authorization is never read — so a delegation token can never mint
// a session, a Supabase JWT, or another delegation through these routes.
import { createHash } from "node:crypto";
import { serviceDb } from "@/lib/db/service";

export type WebSession = {
  sessionId: string;
  userId: string;
  handle: string | null;
  primaryWalletAddress: string | null;
};

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const cookieValue = (req: Request, name: string): string | null => {
  const prefix = `${name}=`;
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const p = part.trim();
    if (p.startsWith(prefix)) {
      const v = p.slice(prefix.length);
      return v === "" ? null : v;
    }
  }
  return null;
};

export async function readSession(req: Request): Promise<WebSession | null> {
  const raw = cookieValue(req, "__Host-mb_session");
  if (!raw) return null;

  const { data: session } = await serviceDb
    .from("sessions")
    .select("id, user_id")
    .eq("token_sha256", sha256hex(raw))
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle()
    .returns<{ id: string; user_id: string }>();
  if (!session) return null;

  const [{ data: profile }, { data: wallet }] = await Promise.all([
    serviceDb
      .from("profiles")
      .select("handle")
      .eq("user_id", session.user_id)
      .maybeSingle()
      .returns<{ handle: string | null }>(),
    serviceDb
      .from("wallets")
      .select("address")
      .eq("user_id", session.user_id)
      .eq("is_primary", true)
      .maybeSingle()
      .returns<{ address: string }>(),
  ]);

  return {
    sessionId: session.id,
    userId: session.user_id,
    handle: profile?.handle ?? null,
    primaryWalletAddress: wallet?.address ?? null,
  };
}
