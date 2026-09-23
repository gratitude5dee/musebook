// apps/worker/src/slate-builder.ts — §9.21's SlateBuilder: the
// WorkerEntrypoint musebook-edge reaches over its MIXER service binding AND
// the hourly cron's per-viewer build. One build path for both; never a route.
//
// §9.23's order: needsBuild() dedupe -> buildQuery() -> execute() the pipeline
// -> ports.slates.writeSlate() inside the pass, ONE statement -> side effects
// under ctx.waitUntil(). §9.20 rung B5: a thrown pass writes NO slate — the
// previous slate keeps serving until it expires and the edge's read-time
// ladder (R2/R3) covers the gap; a half-built slate is worse than an old one.
// B1–B4 (source drops, age-widened rerun, sourceScore sort, reverse-chron
// top-up) are not yet implemented in the framework — DEVIATIONS.md tracks it.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  buildQuery,
  cohortKeyFor,
  execute,
  HeuristicMuseRanker,
  musePipeline,
  reelsPipeline,
  slateRowFor,
} from "@musebook/muse-mixer";
import { PostgresWeightsLoader } from "@musebook/muse-mixer/adapters/pg";
import { workersExecCtx } from "@musebook/muse-mixer/adapters/workers";
import { pgCachedJobs, pgFreshJobs } from "./db.js";
import { feedPorts } from "./feed/ports.js";

export interface SlateRequest {
  surface: string;
  actorUserId?: string | null;
  actorAgentId?: string | null;
  country?: string;
  limit?: number;
}

export interface BuildSlateResult {
  slateId: string | null;
  built: boolean;
  reason?: string;
  size?: number;
}

function envRecord(env: Env): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

/**
 * One scored slate build. `ctx` may be omitted (tests, the cron chunk driver)
 * — the side effects then run awaited inline instead of under waitUntil.
 */
export async function buildSlateCore(
  env: Env,
  req: SlateRequest,
  ctx?: ExecutionContext,
): Promise<BuildSlateResult> {
  const cached = await pgCachedJobs(env);
  const fresh = await pgFreshJobs(env);
  try {
    const ports = feedPorts({ cached, fresh, ae: env.TELEMETRY });
    const minRemainingSeconds =
      Number(envRecord(env)["MUSE_SLATE_TTL_SECONDS"] ?? 900) / 3;
    if (
      !(await ports.slates.needsBuild(
        req.actorUserId ?? null,
        req.actorAgentId ?? null,
        req.surface,
        minRemainingSeconds,
      ))
    ) {
      return { slateId: null, built: false, reason: "fresh_enough" };
    }

    // Resolve the cohort's gates BEFORE the ExecCtx exists: surface is already
    // known at query-build time, so `surface:reels` knobs resolve correctly;
    // the hydrated-cohort row is what RankingScorer loads inside the pass.
    const baseCtx = workersExecCtx({
      env: envRecord(env),
      db: ports,
      ae: env.TELEMETRY,
    });
    const loader = new PostgresWeightsLoader(cached);
    const query = buildQuery(
      {
        surface: req.surface,
        actorUserId: req.actorUserId ?? null,
        actorAgentId: req.actorAgentId ?? null,
        country: req.country ?? null,
        ...(req.limit === undefined ? {} : { limit: req.limit }),
      },
      baseCtx,
    );
    let gates: Record<string, number | boolean> = {};
    try {
      gates = (await loader.load(cohortKeyFor(query, baseCtx))).gates;
    } catch {
      // No weights row for this cohort -> env vars and defaults only.
    }
    const execCtx = workersExecCtx({
      env: envRecord(env),
      db: ports,
      ae: env.TELEMETRY,
      gates,
    });

    const pipelineOpts = {
      ranker: new HeuristicMuseRanker(),
      weightsLoader: loader,
    };
    const pipeline =
      req.surface === "reels"
        ? reelsPipeline(pipelineOpts)
        : musePipeline(pipelineOpts);

    try {
      const result = await execute(pipeline, query, execCtx);
      // §9.23: ONE statement, inside the pass — before the side effects run.
      await ports.slates.writeSlate(slateRowFor(query, result));
      const sideEffects = result.sideEffects();
      if (ctx !== undefined) ctx.waitUntil(sideEffects);
      else await sideEffects;
      return {
        slateId: query.slateId,
        built: true,
        size: result.selected.length,
      };
    } catch (e) {
      // §9.20 rung B5: total failure writes NO slate — the previous slate
      // keeps serving and the edge's R2/R3 ladder covers the gap.
      return {
        slateId: null,
        built: false,
        reason: `mixer_failed:${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } finally {
    await Promise.allSettled([cached.end(), fresh.end()]);
  }
}

/** buildSlate() is the service-binding RPC — never a route (§9.21). */
export class SlateBuilder extends WorkerEntrypoint<Env> {
  async buildSlate(req: SlateRequest): Promise<BuildSlateResult> {
    return buildSlateCore(this.env, req, this.ctx);
  }
}

/** Queue-side: a `slate_build` job's payload, already claimed by the
 *  consumer skeleton — the surface + actor are all a build needs. */
export async function runSlateJob(env: Env, payload: SlateRequest): Promise<void> {
  await buildSlateCore(env, payload);
}
