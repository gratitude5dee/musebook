// apps/web/app/api/internal/sandbox/build/route.ts — §10.8.3's build seam.
// Same signed contract + same deny-all Vercel Sandbox pipeline as the ingest
// route; a build step that needs the network is a build step that can
// exfiltrate, so both routes share one handler.
export const runtime = "nodejs";
import { handleArtifactIngest } from "@/lib/internal/artifacts";

export async function POST(req: Request) {
  return handleArtifactIngest(req);
}
