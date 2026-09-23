// apps/edge/src/routes/consent.ts — POST /api/consent (§15.10).
// ConsentGate's only write. Anonymous subjects record under anon_id; signed-in
// subjects record under user_id and flip users.analytics_consent in the same
// statement (app.record_consent_event).
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { fresh } from "../db/client.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const PURPOSES = new Set(["analytics", "marketing"]);
const SOURCES = new Set(["banner", "settings", "signup", "gpc", "dnt"]);

export async function handleConsent(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const purpose = typeof raw?.purpose === "string" ? raw.purpose : "";
  const granted = raw?.granted === true;
  const source = typeof raw?.source === "string" && SOURCES.has(raw.source) ? raw.source : "banner";
  if (!PURPOSES.has(purpose)) return json({ error: "bad_purpose" }, 400);

  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  const userId =
    actor.class === "human_creator" || actor.class === "human_reader" ? actor.userId : null;
  const anonId =
    userId === null ? (request.headers.get("x-mb-anon-id") ?? crypto.randomUUID()) : null;
  if (userId === null && anonId === null) return json({ error: "no_subject" }, 400);

  const db = fresh(env);
  try {
    await db.query("select app.record_consent_event($1::uuid, $2, $3, $4, $5) as id", [
      userId,
      anonId,
      purpose,
      granted,
      source,
    ]);
  } finally {
    await db.end().catch(() => undefined);
  }
  return json({ ok: true }, 202);
}
