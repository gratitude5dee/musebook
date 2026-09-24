// packages/media/src/node/provenance.ts — §11.10 verbatim.
// NODE ONLY — imported by apps/web ONLY (§11.1). c2pa-node needs a native
// binding that workerd cannot load; sharp is a libvips binding.
import { Builder, LocalSigner, Reader } from "@contentauth/c2pa-node";
import type { DestinationBufferAsset } from "@contentauth/c2pa-node";
import type { Manifest } from "@contentauth/c2pa-types";
import sharp from "sharp";
import { dct2d } from "./dct"; // separable type-II DCT; no dependency needed

export interface ProvenanceInput {
  readonly bytes: Buffer;
  readonly mimeType: string; // 'image/png' | 'video/mp4' | 'model/gltf-binary'
  readonly title: string;
  readonly modelId: string;
  readonly backend: "fal" | "replicate";
  readonly promptSha256: string;
  readonly authorKind: "human" | "agent";
  readonly authorWallet: string;
  readonly authorDisplayName: string;
  readonly connectorSlug: string | null;
  readonly delegationId: string | null;
  readonly postUrl: string | null; // canonical https://musebook.dev/p/{slug}, §6.6
}

export interface ProvenanceOutput {
  readonly signed: Buffer; // asset with the manifest embedded
  readonly sidecar: Buffer; // the manifest store on its own -> `${objectKey}.c2pa`
}

export async function signAsset(input: ProvenanceInput): Promise<ProvenanceOutput> {
  const manifest: Manifest = {
    claim_generator_info: [{ name: "Musebook", version: "1.0.0" }],
    title: input.title,
    format: input.mimeType,
    assertions: [
      {
        label: "c2pa.actions",
        data: {
          actions: [
            {
              action: "c2pa.created",
              digitalSourceType:
                "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
              softwareAgent: { name: input.modelId, version: input.backend },
            },
          ],
        },
      },
      {
        label: "stds.schema-org.CreativeWork",
        data: {
          "@context": "https://schema.org",
          "@type": "CreativeWork",
          author: [
            { "@type": "Person", identifier: input.authorWallet, name: input.authorDisplayName },
            ...(input.connectorSlug
              ? [
                  {
                    "@type": "SoftwareApplication",
                    name: input.connectorSlug,
                    identifier: `musebook:connector:${input.connectorSlug}`,
                  },
                ]
              : []),
          ],
        },
      },
      {
        label: "com.musebook.attribution",
        data: {
          authorKind: input.authorKind,
          connectorId: input.connectorSlug,
          delegationId: input.delegationId,
          humanWallet: input.authorWallet,
          promptSha256: input.promptSha256,
          postUrl: input.postUrl,
        },
      },
    ],
  };

  const builder = await Builder.withJsonAsync(manifest);
  const signer = LocalSigner.newSigner(
    Buffer.from(process.env.C2PA_SIGNING_CERT_PEM!, "utf8"),
    Buffer.from(process.env.C2PA_SIGNING_KEY_PEM!, "utf8"),
    "es256",
    process.env.C2PA_TSA_URL,
  );

  // DestinationBufferAsset is `{ buffer: Buffer | null }` — "an initially empty
  // buffer that will be filled with the signed asset". sign() returns the
  // manifest-store bytes; the signed asset lands in output.buffer.
  const output: DestinationBufferAsset = { buffer: null };
  const sidecar: Buffer = builder.sign(
    signer,
    { buffer: input.bytes, mimeType: input.mimeType },
    output,
  );
  if (!output.buffer) throw new Error("c2pa sign produced no output buffer");
  return { signed: output.buffer, sidecar };
}

export async function readProvenance(
  bytes: Buffer,
  mimeType: string,
): Promise<Record<string, unknown> | null> {
  const reader = await Reader.fromAsset({ buffer: bytes, mimeType });
  return reader ? (reader.json() as Record<string, unknown>) : null;
}

/** 64-bit DCT pHash. Returns a 64-character '0'/'1' string for Postgres bit(64). */
export async function perceptualHash(bytes: Buffer): Promise<string> {
  const raw = await sharp(bytes).greyscale().resize(32, 32, { fit: "fill" }).raw().toBuffer();
  const pixels = Array.from(raw, (v) => v / 255);
  const dct = dct2d(pixels, 32); // 32x32 -> 32x32
  const low: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) low.push(dct[y * 32 + x]!);
  const withoutDc = low.slice(1);
  const sorted = [...withoutDc].sort((a, b) => a - b);
  const median = (sorted[30]! + sorted[31]!) / 2;
  return low.map((v) => (v > median ? "1" : "0")).join("");
}
