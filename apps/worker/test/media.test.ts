// apps/worker/test/media.test.ts — M19's pipeline proofs over the REAL local
// DB + miniflare R2/queues. fetch is the only stub: it fronts the safety
// gateway, fal, Replicate, the provider asset URL, and the provenance
// endpoint — all network the consumers would otherwise do for real.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { withDb, withWorkerDb, resetSeed } from "./helpers/db.js";

const DELEGATION = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002"; // seed agent, media:generate
const OWNER = "11111111-1111-4111-8111-000000000003";

// sha256('a river at dusk')
const PROMPT_SHA = "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd";

/** submit_media_job over the admin connection — the same call the edge makes. */
async function submitJob(idem: string, kind = "image", modelId = "fal-ai/nano-banana-pro") {
  return await withDb(async (c) => {
    const { rows } = await c.query<{
      allowed: boolean; reason: string; media_job_id: string | null;
      job_id: number | null; reservation_id: string | null;
    }>(
      `select * from public.submit_media_job($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9::jsonb)`,
      [DELEGATION, OWNER, kind, modelId, "a river at dusk", PROMPT_SHA, "40000", idem, "{}"],
    );
    return rows[0]!;
  });
}

const deliver = async (queue: string, body: unknown) => {
  const ctx = createExecutionContext();
  await worker.queue(
    {
      queue,
      messages: [{
        id: `m-${crypto.randomUUID().slice(0, 8)}`,
        timestamp: new Date(),
        body,
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      }],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
};

// The Vercel AI Gateway speaks LanguageModelV3: POST {base}/language-model
// with content[]/finishReason/usage tokens on the way back.
const gatewayAllow = (verdict = { verdict: "allow", categories: [] as string[] }) =>
  new Response(
    JSON.stringify({
      id: "resp_stub",
      model: "stub",
      content: [{ type: "text", text: JSON.stringify(verdict) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
      warnings: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

beforeEach(resetSeed);

// R2 buckets persist across tests — a finalize in one test would leak its
// objects into another's zero-writes assertion.
beforeEach(async () => {
  for (const binding of ["PUBLIC_MEDIA", "PAID_MEDIA", "UPLOADS_MEDIA"] as const) {
    const bucket = env[binding] as R2Bucket | undefined;
    if (!bucket) continue;
    const listed = await bucket.list();
    if (listed.objects.length) {
      await bucket.delete(listed.objects.map((o) => o.key));
    }
  }
});

beforeEach(() => {
  env.AI_GATEWAY_API_KEY = "test";
  env.AI_GATEWAY_BASE_URL = "https://gw.test";
  env.GEN_MODEL = "anthropic/claude-opus-5";
  env.MEDIA_WEBHOOK_BASE_URL = "https://musebook.dev";
  env.FAL_KEY = "test-fal";
  env.REPLICATE_API_TOKEN = "test-repl";
  env.MB_INTERNAL_SIGNING_KEY = "dGVzdA=="; // b64 bytes — provenance POST is stubbed anyway
  env.MB_INTERNAL_KEY_ID = "test-key";
});

afterAll(() => vi.unstubAllGlobals());

/** Stub fetch with a router fn — real fetch is never reached in this file. */
function stubFetch(router: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    return router(url, init);
  });
}

describe("M19: submit + finalize pipeline", () => {
  it("M19.1 submit_media_job holds spend once; replay returns the same job", async () => {
    const a = await submitJob("test-m19-idem");
    expect(a.allowed).toBe(true);
    expect(a.media_job_id).toBeTruthy();
    const b = await submitJob("test-m19-idem");
    expect(b.reason).toBe("replay");
    expect(b.media_job_id).toBe(a.media_job_id);
    // One reservation row for the two calls.
    const n = await withDb((c) =>
      c.query<{ n: string }>(
        `select count(*)::text n from public.agent_spend_reservations where id = $1`,
        [a.reservation_id],
      ),
    );
    expect(n.rows[0]!.n).toBe("1");
  });

  it("M19.3 fal 503 fails over to Replicate; the reservation stays singular", async () => {
    // Turn the seeded Replicate placeholder on for the failover window.
    await withDb((c) =>
      c.query(`update public.media_models set enabled=true where model_id='UNVERIFIED-replicate-image-default'`),
    );
    try {
      const job = await submitJob("test-m19-failover");
      const calls: string[] = [];
      stubFetch(async (url) => {
        calls.push(url);
        if (url.includes("gw.test")) return gatewayAllow();
        if (url.includes("queue.fal.run")) return new Response("down", { status: 503 });
        if (url === "https://api.replicate.com/v1/predictions") {
          return new Response(
            JSON.stringify({
              id: "pred-failover-1",
              status: "starting",
              urls: {
                get: "https://api.replicate.com/v1/predictions/pred-failover-1",
                cancel: "https://api.replicate.com/v1/predictions/pred-failover-1/cancel",
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("unrouted", { status: 599 });
      });
      await deliver("musebook-media", { job_id: Number(job.job_id) });
      const { rows } = await withDb((c) =>
        c.query<{ status: string; backend: string | null; provider_request_id: string | null }>(
          `select status, backend, provider_request_id from public.media_jobs where id=$1`,
          [job.media_job_id],
        ),
      );
      expect(rows[0]!.status).toBe("running");
      expect(rows[0]!.backend).toBe("replicate");
      expect(rows[0]!.provider_request_id).toBe("pred-failover-1");
      expect(calls.filter((u) => u.includes("queue.fal.run")).length).toBeGreaterThan(0);
      // One hold, never re-reserved on failover.
      const res = await withDb((c) =>
        c.query<{ n: string; state: string }>(
          `select count(*)::text n, min(state) state from public.agent_spend_reservations
             where external_ref=$1`, [job.media_job_id],
        ),
      );
      expect(res.rows[0]!.n).toBe("1");
    } finally {
      await withDb((c) =>
        c.query(`update public.media_models set enabled=false where model_id like 'UNVERIFIED%'`),
      );
    }
  });

  it("M19.1 finalize: webhook dedupe ×10 → one asset, one settled reservation; redelivery deletes the collision", async () => {
    const job = await submitJob("test-m19-final");
    // Drive it to 'running' by hand — the webhook's job is to finalize, and
    // the submit half is covered by the failover test above.
    await withDb((c) =>
      c.query(
        `update public.media_jobs
            set status='running', backend='replicate', model_id='UNVERIFIED-replicate-image-default',
                provider_request_id='pred-final-1', started_at=now()
          where id=$1`, [job.media_job_id]),
    );

    const png = await (await import("node:buffer")).Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    stubFetch(async (url) => {
      if (url === "https://api.replicate.com/v1/predictions/pred-final-1") {
        return new Response(
          JSON.stringify({
            id: "pred-final-1",
            status: "succeeded",
            urls: { get: url, cancel: `${url}/cancel` },
            output: "https://files.test/out.png",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://files.test/out.png") {
        return new Response(new Uint8Array(png), { status: 200 });
      }
      if (url.includes("/api/internal/media/provenance")) {
        return new Response(
          JSON.stringify({
            phash: "0".repeat(64), phashFrames: null, thumbnailBase64: null,
            frameBase64s: null, signedBase64: null, sidecarBase64: null,
            width: 1, height: 1, durationMs: null, manifestJson: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("gw.test")) return gatewayAllow();
      return new Response("unrouted", { status: 599 });
    });

    // M19.1 first half — ten deliveries produce ONE outbox row (dedupe_key).
    // app.enter inside enqueue_job needs the musebook_worker session role —
    // the postgres superuser's plane memberships are admin-only, not set.
    for (let i = 0; i < 10; i++) {
      await withWorkerDb((c) =>
        c.query(
          `select app.enqueue_job('media_finalize', $1, ($2::text)::jsonb, null)`,
          [job.media_job_id, JSON.stringify({ media_job_id: job.media_job_id, provider: "replicate" })],
        ),
      );
    }
    const { rows: outboxRows } = await withDb((c) =>
      c.query<{ n: string }>(
        `select count(*)::text n from public.job_outbox
          where kind='media_finalize' and dedupe_key=$1`, [job.media_job_id!]),
    );
    expect(outboxRows[0]!.n).toBe("1");

    const outboxId = await withDb(async (c) => {
      const { rows } = await c.query<{ id: number }>(
        `select id from public.job_outbox where kind='media_finalize' and dedupe_key=$1`,
        [job.media_job_id],
      );
      return rows[0]!.id;
    });

    await deliver("musebook-media-finalize", { job_id: Number(outboxId) });
    const { rows: fin } = await withDb((c) =>
      c.query<{ status: string; asset_id: string | null; spend_settled: boolean }>(
        `select status, asset_id::text, spend_settled from public.media_jobs where id=$1`,
        [job.media_job_id],
      ),
    );
    expect(fin[0]!.status).toBe("succeeded");
    expect(fin[0]!.asset_id).toBeTruthy();
    expect(fin[0]!.spend_settled).toBe(true);
    const { rows: assets } = await withDb((c) =>
      c.query<{ n: string; storage: string; key: string }>(
        `select count(*)::text n, min(storage::text) storage, min(object_key) key
           from public.assets where source_kind='generated'`, [],
      ),
    );
    expect(assets[0]!.n).toBe("1");
    expect(assets[0]!.storage).toBe("r2_public");
    // The settled reservation is real, not just a flag.
    const { rows: resv } = await withDb((c) =>
      c.query<{ state: string; n: string }>(
        `select state, count(*)::text n from public.agent_spend_reservations
          where external_ref=$1 group by state`, [job.media_job_id!]),
    );
    expect(resv.length).toBe(1);
    expect(resv[0]!.state).toBe("settled");
    expect(resv[0]!.n).toBe("1");
    // The bytes actually landed in R2 under the m/ key.
    const listed = await (env.PUBLIC_MEDIA as R2Bucket).list({ prefix: "m/" });
    expect(listed.objects.length).toBe(1);

    // The collision branch (M19.1's second half): TWO finalize consumers on
    // the SAME job — the real race the fn's conditional UPDATE guards. Both
    // read 'running', both write the same sha-keyed object; the lock admits
    // one — the loser gets already_final and deletes its colliding write.
    // Either way the invariant is the same: at most one object survives.
    const { runMediaFinalize } = await import("../src/consumers/media-finalize.js");
    await Promise.all([
      runMediaFinalize(env, job.media_job_id!),
      runMediaFinalize(env, job.media_job_id!),
    ]);
    const after = await (env.PUBLIC_MEDIA as R2Bucket).list({ prefix: "m/" });
    expect(after.objects.length).toBeLessThanOrEqual(1); // never double-stored
    const { rows: assets2 } = await withDb((c) =>
      c.query<{ n: string }>(`select count(*)::text n from public.assets where source_kind='generated'`),
    );
    expect(assets2[0]!.n).toBe("1");
  });

  it("M19.2 gate 2b block: LLM says block → blocked_safety, zero R2 writes", async () => {
    const job = await submitJob("test-m19-block");
    stubFetch(async (url) => {
      if (url.includes("gw.test")) {
        return gatewayAllow({ verdict: "block", categories: ["violence"] });
      }
      return new Response("unrouted", { status: 599 });
    });
    await deliver("musebook-media", { job_id: Number(job.job_id) });
    const { rows } = await withDb((c) =>
      c.query<{ status: string; asset_id: string | null }>(
        `select status, asset_id::text from public.media_jobs where id=$1`,
        [job.media_job_id],
      ),
    );
    expect(rows[0]!.status).toBe("blocked_safety");
    expect(rows[0]!.asset_id).toBeNull();
    const listed = await (env.PUBLIC_MEDIA as R2Bucket).list({});
    expect(listed.objects.length).toBe(0);
  });
});
