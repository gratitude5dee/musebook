// packages/media/src/fal.ts — §11.3, near-verbatim.
// Every call is against the QUEUE host (queue.fal.run), never the synchronous
// fal.run host. Auth is `Authorization: Key ${FAL_KEY}` — the literal word Key.
// DEVIATION from the spec excerpt: estimateCostAtomic "reads media_models",
// so the factory also takes the MediaModelStore — (falKey, store), not (falKey).
import type { GenerateRequest, MediaBackend } from "./backend";
import { priceFor, type MediaModelStore } from "./registry";
import { verifyFalWebhook } from "./webhook/fal";

const FAL_QUEUE = "https://queue.fal.run";

const ASPECT_TO_IMAGE_SIZE: Record<GenerateRequest["aspectRatio"], string> = {
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
  "4:3": "landscape_4_3",
  "3:4": "portrait_4_3",
};

/**
 * A FACTORY, not a module-scope constant. A Worker has no process.env — it has
 * a per-invocation `env` object — and module scope runs once per isolate under
 * a 1-second budget.
 */
export function createFalBackend(
  falKey: string,
  store: MediaModelStore,
  jwksUrl?: string,
): MediaBackend {
  const headers = (): HeadersInit => ({
    Authorization: `Key ${falKey}`,
    "Content-Type": "application/json",
    // Provider-side files expire in 2 hours. We re-host into R2 within seconds.
    "X-Fal-Object-Lifecycle-Preference": JSON.stringify({
      expiration_duration_seconds: 7200,
    }),
  });

  const estimate = async (req: GenerateRequest, modelId: string): Promise<string> => {
    const rows = await store.listModels(req.kind);
    const model = rows.find((r) => r.backend === "fal" && r.modelId === modelId);
    if (!model) throw new Error(`no_price_for_model: ${modelId}`);
    const price = priceFor(model, req);
    if (price === null) throw new Error(`no_price_for_model: ${modelId}`);
    return price;
  };

  const backend: MediaBackend = {
    name: "fal",

    supports: (kind) => kind === "image" || kind === "video",

    estimateCostAtomic: (req, modelId) => estimate(req, modelId),

    async submit(req, modelId, webhookUrl) {
      const body: Record<string, unknown> =
        req.kind === "image"
          ? {
              prompt: req.prompt,
              image_size: ASPECT_TO_IMAGE_SIZE[req.aspectRatio],
              num_images: 1,
              ...(req.seed !== undefined ? { seed: req.seed } : {}),
            }
          : {
              prompt: req.prompt,
              aspect_ratio: req.aspectRatio,
              duration: req.durationSeconds ?? 5,
              ...(req.referenceImageUrl ? { image_url: req.referenceImageUrl } : {}),
            };

      const url = `${FAL_QUEUE}/${modelId}?fal_webhook=${encodeURIComponent(webhookUrl)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`fal submit ${res.status}: ${text}`) as Error & {
          httpStatus?: number;
        };
        err.httpStatus = res.status;
        throw err;
      }

      const json: {
        request_id: string;
        status_url: string;
        cancel_url: string;
        response_url: string;
      } = await res.json();
      return {
        backend: "fal",
        modelId,
        providerRequestId: json.request_id,
        estimatedCostAtomic: await estimate(req, modelId),
        statusUrl: json.status_url,
        cancelUrl: json.cancel_url,
        resultUrl: json.response_url,
      };
    },

    async poll(ref) {
      const res = await fetch(ref.statusUrl!, { headers: headers() });
      if (!res.ok) return { status: "failed", error: `fal status ${res.status}` };
      const json: { status: string; queue_position?: number } = await res.json();
      if (json.status === "IN_QUEUE") {
        return { status: "queued", queuePosition: json.queue_position ?? null };
      }
      if (json.status === "IN_PROGRESS") return { status: "running" };
      return backend.fetchResult(ref);
    },

    async fetchResult(ref) {
      const res = await fetch(ref.resultUrl!, { headers: headers() });
      if (!res.ok) return { status: "failed", error: `fal result ${res.status}` };
      const json: {
        images?: {
          url: string;
          width?: number;
          height?: number;
          content_type?: string;
        }[];
        video?: { url: string; content_type?: string };
        has_nsfw_concepts?: boolean[];
      } = await res.json();
      if (json.images?.length) {
        return {
          status: "succeeded",
          assets: json.images.map((im, i) => ({
            url: im.url,
            mimeType: im.content_type ?? "image/png",
            ...(im.width !== undefined ? { width: im.width } : {}),
            ...(im.height !== undefined ? { height: im.height } : {}),
            ...(json.has_nsfw_concepts?.[i] !== undefined
              ? { providerNsfw: json.has_nsfw_concepts[i] }
              : {}),
          })),
        };
      }
      if (json.video) {
        return {
          status: "succeeded",
          assets: [{ url: json.video.url, mimeType: json.video.content_type ?? "video/mp4" }],
        };
      }
      return { status: "failed", error: "fal returned no recognised asset field" };
    },

    async cancel(ref) {
      if (!ref.cancelUrl) return;
      await fetch(ref.cancelUrl, { method: "PUT", headers: headers() });
    },

    verifyWebhook: jwksUrl
      ? (headers, rawBody) => verifyFalWebhook(headers, rawBody, jwksUrl)
      : () => Promise.resolve(null),
  };

  return backend;
}
