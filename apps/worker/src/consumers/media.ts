// apps/worker/src/consumers/media.ts — §11.7.2's SUBMIT half: claims the
// media_jobs row the edge route wrote, runs safety gate 2b (the LLM prompt
// screen — AI_GATEWAY_API_KEY is J-scoped so it lives here, never on the
// edge), resolves the model row, submits, records the provider handle, and
// returns. It NEVER waits for a generation — the failover budget is the
// consumer's 15-minute wall clock, so two submits at 20s timeouts bound the
// worst case at roughly 45 seconds (§11.4).
//
// Failover: a 5xx / connection error / timeout submits ONCE through the other
// backend (§11.4 step 4). Both attempts write an audit_log row with
// action='media.submit'.
import {
  backendByName,
  createBackends,
  pickModel,
  screenPrompt,
  type BackendName,
  type GenerateRequest,
  type MediaModelRow,
  type MediaModelStore,
} from "@musebook/media";
import { audit } from "../lib/audit.js";
import { pgFreshJobs, type DbClient } from "../db.js";

export interface MediaJobRow {
  id: string;
  kind: "image" | "video";
  idempotency_key: string;
  requested_by_user_id: string | null;
  delegation_id: string | null;
  post_id: string | null;
  backend: string | null;
  model_id: string | null;
  provider_request_id: string | null;
  prompt: string;
  prompt_sha256: string;
  params: Record<string, unknown>;
  status: string;
  attempt: number;
  estimated_cost_atomic: string;
  reservation_id: string | null;
  spend_settled: boolean;
  created_at: string;
}

interface SubmitError extends Error {
  httpStatus?: number;
}

/** §11.4 step 4: 5xx, 408/429, a connection error, or a 20s timeout. */
function isServerSide(err: unknown): boolean {
  const e = err as SubmitError;
  if (e.httpStatus !== undefined) return e.httpStatus >= 500 || e.httpStatus === 408 || e.httpStatus === 429;
  return e instanceof TypeError || e.name === "AbortError" || e.name === "TimeoutError";
}

/** media_models as read by the jobs plane. */
export function mediaModelStore(db: DbClient): MediaModelStore {
  return {
    async listModels(kind) {
      const { rows } = await db.query<{
        backend: BackendName;
        model_id: string;
        kind: "image" | "video";
        slot: string;
        price_atomic: string | null;
        price_unit: "per_asset" | "per_second";
        max_duration_s: number | null;
        preference_rank: number;
        enabled: boolean;
      }>(
        `select backend, model_id, kind, slot, price_atomic::text,
                price_unit, max_duration_s, preference_rank, enabled
           from public.media_models where kind = $1`,
        [kind],
      );
      return rows.map((r) => ({
        backend: r.backend,
        modelId: r.model_id,
        kind: r.kind,
        slot: r.slot,
        priceAtomic: r.price_atomic,
        priceUnit: r.price_unit,
        maxDurationS: r.max_duration_s,
        preferenceRank: r.preference_rank,
        enabled: r.enabled,
      }));
    },
    async perActionCapAtomic(delegationId) {
      if (!delegationId) return null;
      const { rows } = await db.query<{ per_action_cap_atomic: string | null }>(
        `select per_action_cap_atomic::text from public.delegations where id = $1`,
        [delegationId],
      );
      return rows[0]?.per_action_cap_atomic ?? null;
    },
  };
}

async function failJob(
  db: DbClient,
  jobId: string,
  status: "failed" | "blocked_safety" | "cancelled",
  reason: string,
  verdict: Record<string, unknown> = {},
): Promise<void> {
  // ($4::text)::jsonb — the cross-driver bind form (a bare ::jsonb string
  // lands as a scalar under postgres.js; see edge enqueue.ts).
  await db.query(`select * from public.fail_media_job($1,$2,$3,($4::text)::jsonb)`, [
    jobId,
    status,
    reason,
    JSON.stringify(verdict),
  ]);
}

function requestFrom(job: MediaJobRow): GenerateRequest {
  const p = job.params ?? {};
  return {
    kind: job.kind,
    prompt: job.prompt,
    aspectRatio: (p.aspectRatio as GenerateRequest["aspectRatio"]) ?? "1:1",
    quality: (p.quality as GenerateRequest["quality"]) ?? "default",
    maxCostAtomic: (p.maxCostAtomic as string) ?? job.estimated_cost_atomic,
    idempotencyKey: job.idempotency_key,
    ...(p.negativePrompt ? { negativePrompt: p.negativePrompt as string } : {}),
    ...(p.durationSeconds ? { durationSeconds: p.durationSeconds as number } : {}),
    ...(p.referenceImageUrl ? { referenceImageUrl: p.referenceImageUrl as string } : {}),
    ...(p.seed !== undefined ? { seed: p.seed as number } : {}),
  };
}

async function pickRow(
  job: MediaJobRow,
  req: GenerateRequest,
  store: MediaModelStore,
  bound: (n: BackendName) => boolean,
  exclude?: BackendName,
): Promise<MediaModelRow | null> {
  if (job.model_id && !exclude) {
    const rows = await store.listModels(job.kind);
    const named = rows.find(
      (r) => r.modelId === job.model_id && r.enabled && bound(r.backend),
    );
    if (named) return named;
  }
  return pickModel(store, req, { backendBound: bound }, job.delegation_id, exclude);
}

/**
 * Claims the media_jobs row (`status='queued'`), screens the prompt, submits
 * to the resolved backend — with one failover — and leaves the row `running`.
 * Every early return releases the reservation through fail_media_job; nothing
 * is charged for a job that produced no asset.
 */
export async function runMediaSubmit(env: Env, mediaJobId: string): Promise<void> {
  const db = await pgFreshJobs(env);
  try {
    const { rows } = await db.query<MediaJobRow>(
      `select * from public.media_jobs where id = $1`,
      [mediaJobId],
    );
    const job = rows[0];
    if (!job || job.status !== "queued") return; // replay or already transitioned

    // Gate 2b — the LLM prompt screen, before any provider call. A blocked
    // prompt releases the hold; nothing is charged (§11.9).
    const verdict = await screenPrompt(job.prompt, env, {
      ...(job.delegation_id ? { delegation: job.delegation_id } : {}),
    }).catch((e) => {
      // The screen failing OPEN is not an option for a paid action; failing
      // CLOSED releases the hold and lets the operator replay the job.
      return { verdict: "block" as const, categories: [`screen_error:${(e as Error).name}`] };
    });
    if (verdict.verdict === "block") {
      await failJob(db, job.id, "blocked_safety", "gate2b_prompt", {
        gate: "2b_prompt",
        categories: verdict.categories,
      });
      await audit(env, {
        action: "media.submit",
        delegation_id: job.delegation_id,
        target_kind: "media_job",
        target_id: job.id,
        after_state: { denied: true, gate: "2b_prompt", categories: verdict.categories },
      });
      return;
    }

    const req = requestFrom(job);
    const store = mediaModelStore(db);
    const backends = createBackends(env, store);
    const bound = (n: BackendName) => backends.some((b) => b.name === n);

    const webhookFor = (backendName: BackendName) =>
      `${env.MEDIA_WEBHOOK_BASE_URL ?? "https://musebook.dev/api/media/webhook"}/${backendName}?job=${job.id}`;

    let attempt = 0;
    // At most two submits: primary, then one failover (§11.4).
    const seen: BackendName[] = [];
    while (seen.length < 2) {
      attempt += 1;
      const model = await pickRow(
        job,
        req,
        store,
        bound,
        seen.length ? seen[seen.length - 1] : undefined,
      );
      if (!model) {
        await failJob(db, job.id, "failed", attempt === 1 ? "no_price_for_model" : "no_failover_model");
        return;
      }
      const backend = backendByName(backends, model.backend);
      if (!backend) {
        await failJob(db, job.id, "failed", "no_backend_for_model");
        return;
      }
      seen.push(model.backend);
      try {
        const ref = await backend.submit(req, model.modelId, webhookFor(model.backend));
        const { rows: ran } = await db.query<{ id: string }>(
          `update public.media_jobs
              set status='running', backend=$2, model_id=$3, provider_request_id=$4,
                  attempt=$5, started_at=coalesce(started_at, now())
            where id=$1 and status='queued'
          returning id`,
          [job.id, model.backend, model.modelId, ref.providerRequestId, attempt],
        );
        await audit(env, {
          action: "media.submit",
          delegation_id: job.delegation_id,
          target_kind: "media_job",
          target_id: job.id,
          after_state: {
            backend: model.backend,
            model_id: model.modelId,
            attempt,
            transitioned: ran.length > 0,
          },
        });
        return;
      } catch (err) {
        await audit(env, {
          action: "media.submit",
          delegation_id: job.delegation_id,
          target_kind: "media_job",
          target_id: job.id,
          after_state: {
            backend: model.backend,
            model_id: model.modelId,
            attempt,
            error: (err as Error).message.slice(0, 200),
            failover: seen.length < 2 && isServerSide(err),
          },
        });
        if (seen.length >= 2 || !isServerSide(err)) {
          await failJob(db, job.id, "failed", `submit_failed:${(err as Error).message.slice(0, 120)}`);
          return;
        }
      }
    }
  } finally {
    await db.end();
  }
}
