// apps/web/lib/internal/artifacts.ts — §11.12 step 4, shared by the three
// signed sandbox-seam routes (artifacts ingest + the §10.8.3 build and
// §15.5.4 render aliases). Request in, IngestReport-shaped JSON out.
import "server-only";
import { z } from "zod";
import { requireSignedInternal } from "@/lib/internal-auth";

const requestSchema = z.object({
  artifact_id: z.uuid(),
  // §4.4's artifacts.kind vocabulary — post_kind ('app'/'model3d') never
  // reaches this route.
  kind: z.enum(["html_bundle", "react_app", "glb", "image_set"]),
  bundle_b64: z.string().min(1),
});

const MAX_BODY = 20 * 1024 * 1024; // a 12 MB GLB is ~16 MB base64 — reject early.

/** POST handler for every Worker → Vercel artifact-ingest call. The report is
 *  returned verbatim except per-file bytes are re-encoded under the wire's
 *  snake_case names; a zod-invalid body is a 400, not a sandbox run. */
export async function handleArtifactIngest(req: Request): Promise<Response> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) {
    return Response.json({ ok: false, rejection: { code: "bundle_too_large" } }, { status: 413 });
  }
  const body = await req.text();
  const denied = await requireSignedInternal(req, body);
  if (denied !== null) return denied;

  const parsed = requestSchema.safeParse(JSON.parse(body));
  if (!parsed.success) {
    return Response.json(
      { ok: false, rejection: { code: "manifest_invalid", path: "body" } },
      { status: 400 },
    );
  }
  const { runIngest } = await import("@musebook/artifacts/node/sandbox");
  const bundle = Buffer.from(parsed.data.bundle_b64, "base64");
  const report = await runIngest(new Uint8Array(bundle), parsed.data.artifact_id);

  return Response.json({
    ok: report.ok,
    rejection: report.rejection,
    version: report.version,
    manifest: report.manifest,
    entry_path: report.entryPath,
    files: report.files?.map((f) => ({
      path: f.path,
      content_type: f.contentType,
      sha256: f.sha256,
      content_b64: f.bytes,
    })),
    poster:
      report.poster == null
        ? null
        : { content_type: report.poster.contentType, content_b64: report.poster.bytes },
    metrics:
      report.totalBytes === undefined
        ? undefined
        : {
            total_bytes: report.totalBytes,
            file_count: report.fileCount ?? report.files?.length ?? 0,
            gzip_bytes: report.gzipBytes ?? 0,
            triangle_count: report.triangleCount ?? null,
            texture_bytes: report.textureBytes ?? null,
            draw_call_estimate: report.drawCallEstimate ?? null,
          },
  });
}
