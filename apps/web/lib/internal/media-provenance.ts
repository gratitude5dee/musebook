// apps/web/lib/internal/media-provenance.ts — §11.10's provenance endpoint.
// musebook-media-finalize POSTs provider bytes here, §15.5.3-signed; the route
// signs (when C2PA_SIGNING_ENABLED), pHashes, and returns the frame thumbnails
// the worker's gate-3 vision pass screens. It touches NO domain table —
// sign/hash/extract are pure compute.
import "server-only";
import { requireSignedInternal } from "@/lib/internal-auth";
import { z } from "zod";

export const MAX_PROVENANCE_BYTES = 25 * 1024 * 1024;

const requestSchema = z.object({
  bytesB64: z.string(),
  mimeType: z.string().regex(/^[-\w.]+\/[-\w.+]+$/),
  title: z.string().max(200).default(""),
  modelId: z.string().max(200).default(""),
  backend: z.enum(["fal", "replicate"]).default("fal"),
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/).default("0".repeat(64)),
  authorKind: z.enum(["human", "agent"]).default("human"),
  authorWallet: z.string().max(200).default(""),
  authorDisplayName: z.string().max(200).default("creator"),
  connectorSlug: z.string().max(200).nullable().default(null),
  delegationId: z.string().uuid().nullable().default(null),
  postUrl: z.string().max(500).nullable().default(null),
  wantFrames: z.boolean().default(false),
});

export async function handleMediaProvenance(req: Request): Promise<Response> {
  const bodyText = await req.text();
  // §15.5.3 — signature + single-use nonce before any side effect.
  const denied = await requireSignedInternal(req, bodyText);
  if (denied !== null) return denied;

  const parsed = requestSchema.safeParse(JSON.parse(bodyText || "null") as unknown);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const input = parsed.data;

  const bytes = Buffer.from(input.bytesB64, "base64");
  if (bytes.byteLength > MAX_PROVENANCE_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  const media = await import("@musebook/media/node");
  const isVideo = input.mimeType.startsWith("video/");
  const isImage = input.mimeType.startsWith("image/");

  const out: Record<string, unknown> = {
    signedBase64: null,
    sidecarBase64: null,
    phash: null,
    phashFrames: null,
    thumbnailBase64: null,
    frameBase64s: null,
    width: null,
    height: null,
    durationMs: null,
    manifestJson: null,
  };

  // C2PA — default OFF (C2PA_SIGNING_ENABLED). A false run still succeeds and
  // returns c2pa_signed_at=null fields; the signed asset is the default when on.
  if (process.env.C2PA_SIGNING_ENABLED === "true") {
    const { signed, sidecar } = await media.signAsset({
      bytes,
      mimeType: input.mimeType,
      title: input.title,
      modelId: input.modelId,
      backend: input.backend,
      promptSha256: input.promptSha256,
      authorKind: input.authorKind,
      authorWallet: input.authorWallet,
      authorDisplayName: input.authorDisplayName,
      connectorSlug: input.connectorSlug,
      delegationId: input.delegationId,
      postUrl: input.postUrl,
    });
    out.signedBase64 = signed.toString("base64");
    out.sidecarBase64 = sidecar.toString("base64");
    out.manifestJson = await media.readProvenance(signed, input.mimeType).catch(() => null);
  }

  if (isImage) {
    out.phash = await media.perceptualHash(bytes);
    if (input.wantFrames) {
      const sharp = (await import("sharp")).default;
      const thumb = await sharp(bytes)
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .jpeg()
        .toBuffer();
      const meta = await sharp(bytes).metadata();
      out.thumbnailBase64 = thumb.toString("base64");
      out.width = meta.width ?? null;
      out.height = meta.height ?? null;
    }
  } else if (isVideo) {
    // Gate 3 frames at 0/50/90%; the phash soft-binding set at 10/50/90%.
    const safetyFrames = await media.extractVideoFrames(bytes, input.mimeType, [0, 0.5, 0.9], {
      ...(process.env.MEDIA_SANDBOX_IMAGE
        ? { MEDIA_SANDBOX_IMAGE: process.env.MEDIA_SANDBOX_IMAGE }
        : {}),
    });
    const phashSource = await media.extractVideoFrames(
      bytes,
      input.mimeType,
      [0.1, 0.5, 0.9],
      {
        ...(process.env.MEDIA_SANDBOX_IMAGE
          ? { MEDIA_SANDBOX_IMAGE: process.env.MEDIA_SANDBOX_IMAGE }
          : {}),
      },
    );
    out.phashFrames = await media.videoPhashFrames(phashSource);
    if (input.wantFrames) {
      out.frameBase64s = safetyFrames.map((f) => f.toString("base64"));
      out.thumbnailBase64 = safetyFrames[1]?.toString("base64") ?? null;
    }
  }

  return Response.json(out);
}
