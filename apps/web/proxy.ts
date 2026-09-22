import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

// Origin lockdown (CF-SPINE §1.4): <project>.vercel.app stays publicly
// reachable and that is not fixable with DNS, so the ONLY thing standing
// between an agent and the paywall is this check. musebook-edge sets
// `x-musebook-edge: <MUSEBOOK_EDGE_SECRET>`; anything without it gets a 404 —
// never 401/403, which would confirm the host is real.
//
// Vercel Preview deployments have no Worker in front of them, so the check is
// skipped off-production or every preview would 404 (§3.10). §6.12 owns the
// rest of this file's contract (x-mb-* forwarding, twin rewrites).
function safeEqual(header: string, secret: string): boolean {
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function proxy(request: NextRequest) {
  if (process.env.VERCEL_ENV === "production") {
    const presented = request.headers.get("x-musebook-edge") ?? "";
    const secret = process.env.MUSEBOOK_EDGE_SECRET;
    const previous = process.env.MUSEBOOK_EDGE_SECRET_PREVIOUS;
    const ok =
      (secret && safeEqual(presented, secret)) || (previous && safeEqual(presented, previous));
    if (!ok) {
      return new NextResponse(null, { status: 404 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/:path*"] };
