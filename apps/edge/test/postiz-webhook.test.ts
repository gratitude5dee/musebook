// apps/edge/test/postiz-webhook.test.ts — §12.2.6's contract, in isolation:
// the path secret gates on a constant-time compare (404 on any miss), the
// body is only a hint so EVERY well/ill-formed payload returns 200, and the
// queue sees {stage:'reconcile'} messages only — never the outbox shape.
import { describe, expect, it, vi } from "vitest";
import { handlePostizWebhook } from "../src/routes/postiz-webhook.js";

function stubEnv(sendBatch = vi.fn(async () => undefined)) {
  const waits: Promise<unknown>[] = [];
  const env = {
    POSTIZ_WEBHOOK_SECRET: "s3cr3t",
    Q_DISTRIBUTE: { sendBatch },
  } as unknown as Env;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { env, ctx, waits, sendBatch };
}

const post = (body: unknown): Request =>
  new Request("https://musebook.dev/api/webhooks/postiz/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("handlePostizWebhook", () => {
  it("404s on a wrong secret and never parses the body", async () => {
    const { env, ctx, sendBatch } = stubEnv();
    const res = await handlePostizWebhook(post([{ id: "p1" }]), env, ctx, "wrong");
    expect(res.status).toBe(404);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("enqueues one reconcile hint per post id, capped at 100, then 200s", async () => {
    const { env, ctx, waits, sendBatch } = stubEnv();
    const items = Array.from({ length: 120 }, (_, i) => ({ id: `pz_${i}`, state: "PUBLISHED" }));
    const res = await handlePostizWebhook(post(items), env, ctx, "s3cr3t");
    expect(res.status).toBe(200);
    await Promise.all(waits);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const batch = sendBatch.mock.calls[0]?.[0] as { body: unknown }[];
    expect(batch).toHaveLength(100);
    expect(batch[0]?.body).toEqual({ stage: "reconcile", postizPostId: "pz_0" });
  });

  it("still 200s on a malformed body — the hint is lost, the response is not", async () => {
    const { env, ctx, sendBatch } = stubEnv();
    const res = await handlePostizWebhook(
      new Request("https://musebook.dev/api/webhooks/postiz/x", {
        method: "POST",
        body: "not json",
      }),
      env,
      ctx,
      "s3cr3t",
    );
    expect(res.status).toBe(200);
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
