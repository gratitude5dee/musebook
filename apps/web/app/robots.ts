// apps/web/app/robots.ts — previews are indexed by nothing (§16.6 M12.6):
// a Vercel preview URL is an unpaywalled origin, so it must be invisible to
// crawlers entirely. Production is agent-first — llms.txt does the inviting —
// so it disallows only what should never be fetched by a crawler at all.
import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === "preview") {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }
  return {
    rules: [{ userAgent: "*", disallow: ["/api/me/", "/compose", "/studio", "/pay/"] }],
    sitemap: "https://musebook.dev/sitemap.xml",
  };
}
