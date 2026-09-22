// apps/web/app/api/auth/payload/route.ts — §5.4.1 verbatim.
export const runtime = "nodejs";

import { z } from "zod";
import { thirdwebAuth } from "@/lib/auth/thirdweb-auth";
import { serviceDb } from "@/lib/db/service";
import { rateLimit } from "@/lib/ratelimit";

const Query = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.coerce.number().int().positive().default(8453),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    address: url.searchParams.get("address"),
    chainId: url.searchParams.get("chainId") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const address = parsed.data.address.toLowerCase();

  // 20 payloads per address per 10 minutes. Without this, wallet_nonces is an
  // unauthenticated write amplifier: one GET = one row. The address is the key,
  // not the IP — Vercel cannot see a real client IP behind Cloudflare (§2.7);
  // IP-keyed limiting belongs on the Worker.
  if (!(await rateLimit(`siwe:payload:${address}`, 20, 600))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const payload = await thirdwebAuth.generatePayload({
    address,
    chainId: parsed.data.chainId,
  });

  await serviceDb.from("wallet_nonces").insert({
    nonce: payload.nonce,
    address,
    action: "siwe:login",
    message: JSON.stringify(payload),
    expires_at: payload.expiration_time,
  });

  return Response.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
