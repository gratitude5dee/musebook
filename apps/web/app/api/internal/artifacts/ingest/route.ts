// apps/web/app/api/internal/artifacts/ingest/route.ts — §11.12 step 4.
// musebook-worker's r2-events consumer POSTs the staged bundle here, signed
// per §15.5.3; the response is the IngestReport the worker turns into R2
// objects and an artifact_versions row.
export const runtime = "nodejs";
import { handleArtifactIngest } from "@/lib/internal/artifacts";

export async function POST(req: Request) {
  return handleArtifactIngest(req);
}
