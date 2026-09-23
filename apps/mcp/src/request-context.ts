// apps/mcp/src/request-context.ts — params._meta visible inside tool
// handlers, read ONCE at the Worker boundary and replayed into the MCP handler
// untouched (§7.7.1, verbatim). AsyncLocalStorage needs no flag at
// compatibility_date 2026-09-21 — agents/mcp/server imports it for
// getMcpAuthContext() already.
import { AsyncLocalStorage } from "node:async_hooks";

export type McpRequestContext = {
  meta: Record<string, unknown>;
  method: string | null;
  headers: Headers;
  requestId: string;
};

const storage = new AsyncLocalStorage<McpRequestContext>();

export function currentMcpRequest(): McpRequestContext | undefined {
  return storage.getStore();
}

/** Reads params._meta once, then replays the body into the MCP handler untouched. */
export function withMcpRequestContext(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return handler(req);

    const raw = await req.text();
    let meta: Record<string, unknown> = {};
    let method: string | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = parsed as { method?: unknown; params?: { _meta?: unknown } };
        method = typeof body.method === "string" ? body.method : null;
        const m = body.params?._meta;
        if (m && typeof m === "object") meta = m as Record<string, unknown>;
      }
      // JSON-RPC batching was removed in 2025-06-18; an array body gets an
      // empty meta and the SDK produces the protocol error.
    } catch {
      // Malformed JSON: let the SDK answer, do not pre-empt its error shape.
    }

    const replayed = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: raw,
    });

    return storage.run(
      {
        meta,
        method,
        headers: req.headers,
        requestId: req.headers.get("cf-ray") ?? crypto.randomUUID(),
      },
      () => handler(replayed),
    );
  };
}
