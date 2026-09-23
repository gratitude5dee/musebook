// packages/distributor/src/send.ts — §12.3.9 verbatim excerpt + helpers.
// One call per publish instant; a 400 fails the batch, so one bounded retry
// without the offender turns all-or-nothing into partial success.
import { PostizHttpError, type PostizClient, type PostizCreateResult } from "./postiz/client";
import type { PostizCreatePostBody } from "./postiz/types";

/** Pull `{ provider, name, error }.provider` out of a 400 PostValidationException body. */
export function extractProviderFromValidationError(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const provider = (body as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.length > 0 ? provider : null;
}

/** The channel identifier a PostizPostEntry targets — integration.id's platform
 *  is recoverable only if the caller kept it; sendWithPartialRetry takes the
 *  mapping explicitly so nothing about Postiz's shape is guessed. */
export interface SendDeps {
  readonly markJobFailed: (provider: string, body: unknown) => Promise<void>;
  /** entry -> the provider slug that produced it (channels.platform). */
  readonly providerOf: (entry: PostizCreatePostBody["posts"][number]) => string;
}

export async function sendWithPartialRetry(
  client: PostizClient,
  body: PostizCreatePostBody,
  deps: SendDeps,
): Promise<PostizCreateResult> {
  try {
    return await client.createPosts(body);
  } catch (e) {
    if (e instanceof PostizHttpError && e.status === 400) {
      const offender = extractProviderFromValidationError(e.body);
      if (offender !== null && body.posts.length > 1) {
        await deps.markJobFailed(offender, e.body);
        // Retry ONCE without the offending channel. One extra throttle slot and
        // one more of the six connections; it turns an all-or-nothing 400 into
        // a partial success. A second offender is systemic — let it throw so
        // the queue retries the message.
        return client.createPosts({
          ...body,
          posts: body.posts.filter((p) => deps.providerOf(p) !== offender),
        });
      }
    }
    throw e;
  }
}
