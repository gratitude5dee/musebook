// packages/classify/src/errors.ts
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";

/** Queue action the consumer performs for a failed classification.
 *  `event` is the ops_events event_name, drawn from a closed set; `rate_limited`
 *  is the only name excluded from the circuit breaker's count. */
export type Disposition = {
  event:
    | "auth_failed"
    | "bad_request"
    | "unprocessable"
    | "rate_limited"
    | "timeout"
    | "connection"
    | "provider_5xx"
    | "unknown";
  /** true ⇒ write the heuristic row, mark the outbox row dead, ack — no retries. */
  terminal: boolean;
  /** Overrides the consumer's computed backoff when present. */
  retryAfterSeconds?: number | undefined;
};

export function dispositionFor(err: unknown): Disposition {
  if (err instanceof RateLimitError) {
    return {
      event: "rate_limited",
      terminal: false,
      ...(err.retryAfterMs == null
        ? {}
        : { retryAfterSeconds: Math.ceil(err.retryAfterMs / 1000) }),
    };
  }
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return { event: "auth_failed", terminal: false, retryAfterSeconds: 300 };
  }
  if (err instanceof BadRequestError) return { event: "bad_request", terminal: true };
  if (err instanceof UnprocessableEntityError) {
    return { event: "unprocessable", terminal: true };
  }
  if (err instanceof APITimeoutError) return { event: "timeout", terminal: false };
  if (err instanceof APIConnectionError) return { event: "connection", terminal: false };
  if (err instanceof InternalServerError) return { event: "provider_5xx", terminal: false };
  if (err instanceof APIError) return { event: "provider_5xx", terminal: false };
  return { event: "unknown", terminal: false };
}

/** The §8.4 split fallback engages when the API rejects the question set itself:
 *  a 400/422 whose `detail[].loc` identifies the `questions` body field. */
export function isQuestionSetError(err: unknown): boolean {
  if (!(err instanceof BadRequestError || err instanceof UnprocessableEntityError)) {
    return false;
  }
  const body = err.body;
  if (body == null || typeof body !== "object") return false;
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) return false;
  return detail.some((d) => {
    const loc = (d as { loc?: unknown })?.loc;
    return Array.isArray(loc)
      ? loc.includes("questions")
      : typeof loc === "string" && loc.includes("questions");
  });
}
