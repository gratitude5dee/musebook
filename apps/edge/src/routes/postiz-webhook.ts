// apps/edge/src/routes/postiz-webhook.ts  (mounted by musebook-edge)
// §12.2.6 — the URL path carries the shared secret; Postiz webhooks are
// unsigned. Hand-rolled validation: §3.2's package split forbids zod on the
// edge (it arrives transitively through @x402/core but may not be imported),
// and this body is only ever a hint — the reconciler re-reads Postiz itself.
import { bound } from "../db/client.js";

interface PostizWebhookItem {
  id: string;
}

/** Permissive shape check: an array whose elements carry a string `id`.
 *  Anything else on the object is ignored — the reconciler never trusts the
 *  body beyond the post ids. */
function parseItems(raw: unknown): PostizWebhookItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PostizWebhookItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== "string") return null;
    out.push({ id });
  }
  return out;
}

/** Constant-time compare on WebCrypto-safe primitives; no node:crypto needed. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

export async function handlePostizWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  secretFromPath: string,
): Promise<Response> {
  const expected = env.POSTIZ_WEBHOOK_SECRET;
  if (!expected || !constantTimeEquals(secretFromPath, expected)) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const items = parseItems(await req.json().catch(() => null));
  // ALWAYS 200. A non-2xx loses the event forever (no retry upstream) and
  // tells a prober that the secret was right.
  if (items === null) return Response.json({ ok: true });

  // A HINT only: ask the reconciler to look at these Postiz post ids now.
  // Best-effort — if the send throws, the five-minute cron picks the rows up anyway.
  ctx.waitUntil(
    bound(env.Q_DISTRIBUTE, "Q_DISTRIBUTE")
      .sendBatch(
        items.slice(0, 100).map((item) => ({
          body: { stage: "reconcile" as const, postizPostId: item.id },
        })),
      )
      .catch((e: unknown) => console.error("reconcile_enqueue_failed", String(e))),
  );
  return Response.json({ ok: true });
}
