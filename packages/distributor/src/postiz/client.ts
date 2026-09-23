// packages/distributor/src/postiz/client.ts — §12.2.3 verbatim.
// Authentication is the raw organisation API key in the Authorization header
// with NO scheme prefix — a "Bearer " prefix breaks the org lookup (401).
import { z } from "zod";
import type { PostizCreatePostBody } from "./types";

/** The narrow slice of the Worker Env this package needs. See 12.4. */
export interface DistributorEnv {
  readonly POSTIZ_URL: string;
  readonly POSTIZ_API_KEY: string;
  readonly POSTIZ_MEDIA_DOMAIN: string;
  readonly CDN_HOST: string;
  readonly REFORMAT_MODEL?: string;
  readonly REFORMAT_MAX_REPAIRS?: string;
  readonly DISTRIBUTION_ENABLED: string;
  readonly AI_GATEWAY_API_KEY: string;
}

export interface PostizClientConfig {
  /**
   * `${POSTIZ_URL}/api`, i.e. "https://postiz.musebook.dev/api" — no trailing slash,
   * no /public/v1 (the client appends that). Drop the "/api" only when the backend is
   * exposed directly without the container's bundled nginx.
   */
  readonly baseUrl: string;
  /** Raw organisation API key. NEVER prefixed with "Bearer ". */
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class PostizHttpError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    readonly body: unknown,
  ) {
    super(`postiz ${route} -> ${status}`);
    this.name = "PostizHttpError";
  }
}

const mediaRecord = z.object({
  id: z.string(),
  name: z.string(),
  originalName: z.string().nullable().optional(),
  path: z.string(),
  thumbnail: z.string().nullable().optional(),
  alt: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});
export type PostizMedia = z.infer<typeof mediaRecord>;

const integrationRecord = z.object({
  id: z.string(),
  name: z.string(),
  identifier: z.string(),
  picture: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
  profile: z.string().nullable().optional(),
});
export type PostizIntegration = z.infer<typeof integrationRecord>;

const createPostResult = z.array(z.object({ postId: z.string(), integration: z.string() }));
export type PostizCreateResult = z.infer<typeof createPostResult>;

const analyticsSeries = z.array(
  z.object({
    label: z.string(),
    data: z.array(z.object({ total: z.string(), date: z.string() })),
    percentageChange: z.number().optional(),
  }),
);
export type PostizAnalytics = z.infer<typeof analyticsSeries>;

/** Row shape from GET /public/v1/posts?startDate&endDate — the reconciler's
 *  only authority (12.3.9). state is QUEUE/PUBLISHED/ERROR server-side. */
const postRow = z.object({
  id: z.string(),
  publishDate: z.string(),
  releaseURL: z.string().nullable().optional(),
  state: z.string(),
  error: z.string().nullable().optional(),
  integration: z.object({ id: z.string() }).passthrough(),
});
export type PostizPostRow = z.infer<typeof postRow>;

export class PostizClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: PostizClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.doFetch = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(`${this.baseUrl}/public/v1${route}`, {
        method,
        // RAW key. A "Bearer " prefix breaks the org lookup — see above.
        headers: {
          Authorization: this.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      const text = await res.text();
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
      if (!res.ok) throw new PostizHttpError(res.status, route, parsed);
      return schema.parse(parsed);
    } finally {
      clearTimeout(timer);
    }
  }

  listIntegrations(): Promise<PostizIntegration[]> {
    return this.request("GET", "/integrations", z.array(integrationRecord));
  }

  uploadFromUrl(url: string): Promise<PostizMedia> {
    return this.request("POST", "/upload-from-url", mediaRecord, { url });
  }

  /** The ONE batched call. See 12.2.4. */
  createPosts(body: PostizCreatePostBody): Promise<PostizCreateResult> {
    return this.request("POST", "/posts", createPostResult, body);
  }

  postAnalytics(postizPostId: string, days: number): Promise<PostizAnalytics> {
    return this.request(
      "GET",
      `/analytics/post/${encodeURIComponent(postizPostId)}?date=${days}`,
      analyticsSeries,
    );
  }

  integrationSettings(integrationId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/integration-settings/${encodeURIComponent(integrationId)}`,
      z.unknown(),
    );
  }

  /** GET /public/v1/posts — requires BOTH dates (@IsDateString, not optional)
   *  and is NOT throttled; polling it is free (12.3.9). */
  listPosts(startDate: string, endDate: string): Promise<PostizPostRow[]> {
    return this.request(
      "GET",
      `/posts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
      z.array(postRow),
    );
  }

  deletePostGroup(group: string): Promise<unknown> {
    return this.request("DELETE", `/posts/group/${encodeURIComponent(group)}`, z.unknown());
  }
}

/**
 * The one place the sidecar's address and key are read. ONE org, ONE key:
 * Musebook runs a single shared Postiz organisation for every creator
 * (section 18, N9), so the key is the Worker SECRET POSTIZ_API_KEY defined in
 * section 3.7's manifest — never a per-creator value, never a parameter.
 * `env` is the Worker Env passed into the queue handler; a missing value throws
 * rather than silently no-opping (section 16, M10 gate 9).
 */
export function postizClient(env: DistributorEnv): PostizClient {
  const url = env.POSTIZ_URL;
  if (!url) throw new Error("POSTIZ_URL is not set; distribution cannot run");
  const apiKey = env.POSTIZ_API_KEY;
  if (!apiKey) {
    throw new Error("POSTIZ_API_KEY is not set; distribution cannot run");
  }
  return new PostizClient({ baseUrl: `${url.replace(/\/+$/, "")}/api`, apiKey });
}
