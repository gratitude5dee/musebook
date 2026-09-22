// apps/web/proxy.ts — §6.12.7, verbatim: the whole security contract of this
// file is ONE check — 404 anything lacking x-musebook-edge.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// NO `runtime` key anywhere in this file. Setting one THROWS at build:
// "Route segment config is not allowed in Proxy file ... Proxy always runs on
// Node.js runtime." `config.matcher` is legal and is the only export here.
export const config = {
  matcher: ["/((?!_next/static|_next/image|_vercel).*)"],
};

/** Constant-time compare. A length-varying `===` on a shared secret leaks it
 *  one byte at a time to anyone who can measure a few thousand requests. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export function proxy(request: NextRequest): NextResponse {
  // ACME and the well-known paths pass untouched, or Vercel's certificate
  // renewal breaks. They carry no content and no price.
  if (request.nextUrl.pathname.startsWith("/.well-known/")) return NextResponse.next();

  // A preview deployment has NO Worker in front of it (§3.10: the preview
  // Worker has no routes), so demanding the header there would 404 every
  // preview. This is the one place in apps/web where VERCEL_ENV legitimately
  // changes behaviour.
  if (process.env.VERCEL_ENV !== "production") return NextResponse.next();

  const presented = request.headers.get("x-musebook-edge") ?? "";
  const current = process.env.MUSEBOOK_EDGE_SECRET ?? "";
  const previous = process.env.MUSEBOOK_EDGE_SECRET_PREVIOUS ?? "";

  const ok =
    (current !== "" && timingSafeEqual(presented, current)) ||
    (previous !== "" && timingSafeEqual(presented, previous));

  // 404, not 403: a 403 confirms the hostname is live and worth attacking.
  return ok ? NextResponse.next() : new NextResponse(null, { status: 404 });
}
