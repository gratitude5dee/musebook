// apps/edge/src/routes/events.ts — §13.4.3 verbatim; opsLog is the repo's
// ops_events writer (async, fails open — the verbatim pass-through shape).
import { humanBatchSchema } from "@musebook/schema/telemetry";
import { ingestHumanBatch } from "../telemetry/ingest.js";
import { behaviouralOptOut, hashClientIp } from "../telemetry/privacy.js";
import { opsLog } from "../ops.js";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function handleEvents(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: NO_STORE });

  const raw: unknown = await request.json().catch(() => null);
  const parsed = humanBatchSchema.safeParse(raw);
  if (!parsed.success) {
    // 204, not 400. A malformed batch is either a bug we will see in ops_events
    // or a prober; neither deserves an error oracle, and the client ignores the
    // status either way.
    ctx.waitUntil(
      opsLog(env, { component: "telemetry", event_name: "batch_rejected", level: "warn" }),
    );
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  const optedOut = behaviouralOptOut(request.headers);
  const ipHash = optedOut ? null : await hashClientIp(request, env, "human");

  // The response does not wait for either store. AE writes are synchronous and
  // non-blocking; the Postgres write is a Hyperdrive round trip and belongs in
  // waitUntil, which is also why a 204 can be returned before it lands.
  ctx.waitUntil(
    ingestHumanBatch(env, ctx, parsed.data, {
      request,
      optedOut,
      ipHash,
      requestId: request.headers.get("x-mb-request-id") ?? request.headers.get("cf-ray") ?? null,
      country: (request.cf?.country as string | undefined) ?? "XX",
    }).catch((err: unknown) =>
      opsLog(env, {
        component: "telemetry",
        event_name: "ingest_failed",
        level: "error",
        metadata: { message: String(err) },
      }),
    ),
  );

  const headers: Record<string, string> = { ...NO_STORE };
  if (optedOut) {
    headers["set-cookie"] = "mb_optout=1; Path=/; Max-Age=31536000; SameSite=Lax";
  }
  return new Response(null, { status: 204, headers });
}
