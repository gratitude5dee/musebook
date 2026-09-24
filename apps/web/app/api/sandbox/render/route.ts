// apps/web/app/api/sandbox/render/route.ts — §15.5.4's render seam.
// The Worker → Vercel sandbox call: RFC 9421 signature verified inside
// requireSignedInternal, single-use nonce claimed before any side effect.
export const runtime = "nodejs";
import { handleArtifactIngest } from "@/lib/internal/artifacts";

export async function POST(req: Request) {
  return handleArtifactIngest(req);
}
