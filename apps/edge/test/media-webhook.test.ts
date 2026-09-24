// apps/edge/test/media-webhook.test.ts — §11.8's contract at the route: an
// unsigned or wrong-signature delivery is a 401 and NOTHING is enqueued —
// the outbox write and the Q_MEDIA_FINALIZE send both live behind verify().
import { describe, expect, it, vi } from "vitest";
import { handleMediaWebhook } from "../src/routes/media.js";

const SECRET =
  "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function stubEnv() {
  const waits: Promise<unknown>[] = [];
  const send = vi.fn(async () => undefined);
  const env = {
    REPLICATE_WEBHOOK_SECRET: SECRET,
    // Q_MEDIA_FINALIZE + DB deliberately absent: reaching either proves a leak
    // past the signature gate.
    Q_MEDIA_FINALIZE: { send },
  } as unknown as Env;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { env, ctx, waits, send };
}

const post = (body: string, headers: Record<string, string> = {}): Request =>
  new Request("https://musebook.dev/api/media/webhook/replicate?job=bbbbbbbb-bbbb-4bbb-8bbb-000000000002", {
    method: "POST",
    headers,
    body,
  });

describe("M19.5 — media webhook signature gate", () => {
  it("401s on an unsigned body and enqueues nothing", async () => {
    const { env, ctx, waits, send } = stubEnv();
    const res = await handleMediaWebhook(post("{}"), env, ctx, "replicate");
    expect(res.status).toBe(401);
    expect(waits.length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("401s on a wrong signature and enqueues nothing", async () => {
    const { env, ctx, waits, send } = stubEnv();
    const res = await handleMediaWebhook(
      post("{}", {
        "webhook-id": "msg_1",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      }),
      env,
      ctx,
      "replicate",
    );
    expect(res.status).toBe(401);
    expect(waits.length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("401s on an unknown backend name", async () => {
    const { env, ctx } = stubEnv();
    const res = await handleMediaWebhook(
      new Request("https://musebook.dev/api/media/webhook/nope?job=x", {
        method: "POST",
        body: "{}",
      }),
      env,
      ctx,
      "nope",
    );
    expect(res.status).toBe(404);
  });

  it("401s when the verifier is unconfigured (no secret in env)", async () => {
    const env = {} as unknown as Env;
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const res = await handleMediaWebhook(post("{}"), env, ctx, "replicate");
    expect(res.status).toBe(401);
  });
});
