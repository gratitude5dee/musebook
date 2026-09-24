// apps/web/lib/auth/csrf.ts — same-origin check for the mutating web routes.
// The __Host-mb_session cookie is SameSite=Lax, which already blocks cross-site POSTs
// carrying it; this is the second layer for the JSON fetch calls the app makes
// itself, which Lax does not govern. musebook.dev and *.vercel.app previews are
// the only allowed origins — an unexpected Origin/Referer is rejected outright.
const ALLOWED_HOST_SUFFIX = [".vercel.app"];
const ALLOWED_HOST_EXACT = new Set(["musebook.dev", "www.musebook.dev", "localhost"]);

const hostAllowed = (host: string): boolean => {
  const h = host.toLowerCase().split(":")[0];
  if (!h) return false;
  if (ALLOWED_HOST_EXACT.has(h)) return true;
  return ALLOWED_HOST_SUFFIX.some((s) => h.endsWith(s));
};

/**
 * Returns a 403 Response when the request's Origin (or Referer, if Origin is
 * absent) names a host we do not serve from. A request with neither header is
 * a non-browser client (curl, a test) and passes — it cannot ride a victim's
 * browser anyway.
 */
export function requireSameOrigin(req: Request): Response | null {
  const raw = req.headers.get("origin") ?? req.headers.get("referer");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (hostAllowed(url.host)) return null;
  } catch {
    // Unparseable Origin is not one of ours.
  }
  return Response.json({ error: "origin_rejected" }, { status: 403 });
}
