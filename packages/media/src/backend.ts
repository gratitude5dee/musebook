// packages/media/src/backend.ts — §11.2 verbatim.
// GENERATION OUTPUT only: two of §4.2's post_kind values, one-to-one.
// 3D is not a generation kind: a glTF post enters through Part B's ingest
// (11.15) as post_kind = 'model3d'.
import { z } from "zod";

export const mediaKindSchema = z.enum(["image", "video"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const generateRequestSchema = z.object({
  kind: mediaKindSchema,
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(1000).optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).default("1:1"),
  /** Video only. Ignored for image. */
  durationSeconds: z.number().int().min(1).max(20).optional(),
  /**
   * Public https URL of a reference frame. MUST be an https://cdn.musebook.dev/
   * URL — an object in musebook-public. A media.musebook.dev URL is rejected at
   * parse: it is gated, the provider holds no grant, and handing a provider a
   * paid byte to fetch would be a paywall bypass with extra steps.
   */
  referenceImageUrl: z
    .string()
    .url()
    .regex(/^https:\/\/cdn\.musebook\.dev\//, "reference frames must be musebook-public objects")
    .optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  /** §11.4's requested quality slot; the registry prefers the matching row. */
  quality: z.enum(["default", "fast", "cheap", "premium", "i2v"]).default("default"),
  /** Hard ceiling in USDC atomic units (6 decimals). 50_000 = $0.05. */
  maxCostAtomic: z.string().regex(/^[0-9]{1,18}$/),
  /** Rewritten server-side to sha256(delegationId || ':' || clientKey). See 11.8. */
  idempotencyKey: z.string().min(8).max(128),
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export interface GenerateJobRef {
  readonly jobId: string; // Musebook uuid, media_jobs.id
  readonly backend: BackendName;
  readonly modelId: string; // e.g. 'fal-ai/nano-banana-pro'
  readonly providerRequestId: string;
  readonly estimatedCostAtomic: string;
  readonly statusUrl: string | null;
  readonly cancelUrl: string | null;
  readonly resultUrl: string | null;
}

export interface RemoteAsset {
  readonly url: string; // provider-hosted, short-lived
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly providerNsfw?: boolean; // populated when the provider reports it
}

export type PollResult =
  | { readonly status: "queued"; readonly queuePosition: number | null }
  | { readonly status: "running" }
  | { readonly status: "succeeded"; readonly assets: readonly RemoteAsset[] }
  | { readonly status: "failed"; readonly error: string };

export type BackendName = "fal" | "replicate";

export interface MediaBackend {
  readonly name: BackendName;
  supports(kind: MediaKind): boolean;
  /** Deterministic; reads media_models, never a hardcoded literal. See 11.6. */
  estimateCostAtomic(req: GenerateRequest, modelId: string): Promise<string>;
  submit(
    req: GenerateRequest,
    modelId: string,
    webhookUrl: string,
  ): Promise<Omit<GenerateJobRef, "jobId">>;
  poll(ref: GenerateJobRef): Promise<PollResult>;
  cancel(ref: GenerateJobRef): Promise<void>;
  /**
   * Verify a webhook delivery. MUST be given the raw body bytes, never a
   * re-serialised object. Returns the provider request id on success.
   * Runs on workerd in musebook-edge: WebCrypto only.
   */
  verifyWebhook(headers: Headers, rawBody: ArrayBuffer): Promise<string | null>;
  /**
   * Re-read the authoritative result from the provider using our own API key.
   * The webhook is only a nudge; this is the source of truth. See 11.7.
   */
  fetchResult(ref: GenerateJobRef): Promise<PollResult>;
}
