// packages/media/src/replicate.ts — §11.4, spec shape completed.
// Replicate is the failover and the home of models fal does not carry —
// a strictly smaller surface: submit, poll, cancel, verify.
import type { GenerateJobRef, MediaBackend, PollResult } from "./backend";
import { priceFor, type MediaModelStore } from "./registry";
import { verifyReplicateWebhook } from "./webhook/replicate";

const REPLICATE_API = "https://api.replicate.com/v1";

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  urls: { get: string; cancel: string };
  output?: unknown; // string | string[] | { url | url[] } depending on model
  error?: string | { message?: string } | null;
}

function outputAssets(output: unknown): { url: string; mimeType: string }[] {
  if (!output) return [];
  const urls: string[] = [];
  if (typeof output === "string") urls.push(output);
  else if (Array.isArray(output)) {
    for (const o of output) if (typeof o === "string") urls.push(o);
  } else if (typeof output === "object") {
    const o = output as { url?: string; urls?: string[] };
    if (typeof o.url === "string") urls.push(o.url);
    if (Array.isArray(o.urls)) for (const u of o.urls) urls.push(u);
  }
  return urls.map((url) => ({
    url,
    mimeType: url.endsWith(".mp4") ? "video/mp4" : "image/png",
  }));
}

export function createReplicateBackend(
  token: string,
  store: MediaModelStore,
  webhookSecret?: string,
): MediaBackend {
  const headers = (): HeadersInit => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });

  const estimate = async (
    req: Parameters<MediaBackend["estimateCostAtomic"]>[0],
    modelId: string,
  ) => {
    const rows = await store.listModels(req.kind);
    const model = rows.find((r) => r.backend === "replicate" && r.modelId === modelId);
    if (!model) throw new Error(`no_price_for_model: ${modelId}`);
    const price = priceFor(model, req);
    if (price === null) throw new Error(`no_price_for_model: ${modelId}`);
    return price;
  };

  const getPrediction = async (ref: GenerateJobRef): Promise<ReplicatePrediction | null> => {
    const url = ref.resultUrl ?? `${REPLICATE_API}/predictions/${ref.providerRequestId}`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.json();
  };

  const toResult = (p: ReplicatePrediction): PollResult => {
    if (p.status === "starting" || p.status === "processing") return { status: "running" };
    if (p.status === "succeeded") {
      const assets = outputAssets(p.output);
      return assets.length
        ? { status: "succeeded", assets }
        : { status: "failed", error: "replicate succeeded with no output" };
    }
    const err =
      typeof p.error === "string" ? p.error : (p.error?.message ?? `replicate ${p.status}`);
    return { status: "failed", error: err };
  };

  return {
    name: "replicate",
    supports: (kind) => kind === "image" || kind === "video",

    estimateCostAtomic: (req, modelId) => estimate(req, modelId),

    async submit(req, modelId, webhookUrl) {
      const res = await fetch(`${REPLICATE_API}/predictions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          version: modelId, // a Replicate version hash, not an endpoint slug
          input: {
            prompt: req.prompt,
            ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
          },
          webhook: webhookUrl,
          webhook_events_filter: ["start", "completed"],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`replicate submit ${res.status}: ${text}`) as Error & {
          httpStatus?: number;
        };
        err.httpStatus = res.status;
        throw err;
      }
      const json: { id: string; urls: { get: string; cancel: string } } = await res.json();
      return {
        backend: "replicate",
        modelId,
        providerRequestId: json.id,
        estimatedCostAtomic: await estimate(req, modelId),
        statusUrl: json.urls.get,
        cancelUrl: json.urls.cancel,
        resultUrl: json.urls.get,
      };
    },

    async poll(ref) {
      const p = await getPrediction(ref);
      return p ? toResult(p) : { status: "failed", error: "replicate poll failed" };
    },

    async fetchResult(ref) {
      const p = await getPrediction(ref);
      return p ? toResult(p) : { status: "failed", error: "replicate result fetch failed" };
    },

    async cancel(ref) {
      if (!ref.cancelUrl) return;
      await fetch(ref.cancelUrl, {
        method: "POST",
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      });
    },

    verifyWebhook: webhookSecret
      ? (h, b) => verifyReplicateWebhook(h, b, webhookSecret)
      : () => Promise.resolve(null),
  };
}
