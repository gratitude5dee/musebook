// apps/web/lib/internal-auth.ts — §15.5.3's caller authentication on the
// Vercel seam: RFC 9421 signature verify, then a single-use nonce claim.
// Verification runs first (an unauthenticated flood cannot fill the table);
// the claim runs before ANY side effect.
import "server-only";
import { verifyInternalRequest } from "@musebook/schema/internal-signature";
import { serviceDb } from "@/lib/db/service";

export async function requireSignedInternal(
  req: Request,
  body: string,
): Promise<Response | null> {
  const publicKeys = JSON.parse(process.env.MB_INTERNAL_PUBLIC_KEYS ?? "{}") as Record<
    string,
    string
  >;
  const res = verifyInternalRequest({
    method: req.method,
    url: req.url,
    body,
    headers: req.headers,
    publicKeys,
    maxSkewSeconds: Number(process.env.MB_INTERNAL_MAX_SKEW_S ?? "300"),
  });
  if (!res.ok) {
    return Response.json({ error: "unauthorized", reason: res.reason }, { status: 401 });
  }

  const rpcResult: unknown = await serviceDb.rpc("claim_internal_nonce", {
    p_nonce: res.nonce,
    p_key_id: res.keyId,
    p_method: req.method,
    p_path: new URL(req.url).pathname,
    p_expires_at: res.expiresAt.toISOString(),
  });
  const { data, error } = rpcResult as {
    data: boolean | null;
    error: { message: string } | null;
  };
  if (error) {
    return Response.json({ error: "nonce_claim_failed" }, { status: 500 });
  }
  if (data !== true) {
    return Response.json({ error: "replay" }, { status: 409 });
  }
  return null;
}
