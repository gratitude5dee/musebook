// apps/edge/src/http.ts — the plumbing §6.12.2 names in one place.
// toOrigin lives in index.ts verbatim (gate check 14: the PoP client-IP
// header may be read only there and in telemetry/privacy.ts).
import type { Rendered } from "@musebook/schema";
import { paymentRequiredHttp, withSettlement } from "@musebook/x402";

export function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A Rendered is a body plus the headers the kernel already chose. */
export function renderedToResponse(rendered: Rendered): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(rendered.headers)) headers.set(k, v);
  headers.set("content-type", rendered.mediaType);
  return new Response(rendered.body, { status: rendered.status, headers });
}

/**
 * The deny branch of a media read: 402 + PAYMENT-REQUIRED (base64 of the pinned
 * quote). The kernel's decision already carries httpStatus, so no reason→status
 * mapping exists here — §6.4's rule.
 */
export function challengeResponse(decision: Parameters<typeof paymentRequiredHttp>[0]): Response {
  return paymentRequiredHttp(decision);
}

export { withSettlement };

/** Request headers forwarded to the exports gateway — the service-binding fetch
 *  reuses the request's own conditional/range semantics, which `new Request`
 *  drops unless they are copied explicitly. */
export function passthrough(headers: Headers): Headers {
  const out = new Headers();
  for (const name of [
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
    "if-match",
    "if-range",
    "range",
    "accept",
    "accept-encoding",
  ]) {
    const v = headers.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

/** R2 object.range -> the 206 headers. offset+length+total per R2 semantics. */
export function rangeHeaders(range: R2Range, size: number): Headers {
  const out = new Headers();
  // The runtime range object carries all three keys (`suffix` is undefined on
  // offset ranges) — the declared union models only the literal request shape.
  const r = range as { offset?: number; length?: number; suffix?: number };
  if (typeof r.suffix === "number") {
    const len = Math.min(r.suffix, size);
    out.set("content-range", `bytes ${size - len}-${size - 1}/${size}`);
    out.set("content-length", String(len));
    return out;
  }
  const start = r.offset ?? 0;
  const len = r.length ?? size - start;
  out.set("content-range", `bytes ${start}-${start + len - 1}/${size}`);
  out.set("content-length", String(len));
  return out;
}
