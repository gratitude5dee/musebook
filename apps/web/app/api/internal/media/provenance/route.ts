// apps/web/app/api/internal/media/provenance/route.ts — §11.10.
// musebook-worker's media_finalize consumer POSTs here, §15.5.3-signed.
export const runtime = "nodejs";
import { handleMediaProvenance } from "@/lib/internal/media-provenance";

export async function POST(req: Request) {
  return handleMediaProvenance(req);
}
