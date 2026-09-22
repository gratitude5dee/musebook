// apps/worker/src/slate-builder.ts — §9.19's SlateBuilder: the queue consumer
// AND the WorkerEntrypoint musebook-edge reaches over its MIXER service
// binding. One build path for both.
import { WorkerEntrypoint } from "cloudflare:workers";
import { pgFresh } from "./db.js";

export interface SlateRequest {
  surface: string;
  actorUserId?: string | null;
  actorAgentId?: string | null;
  country?: string;
}

/** Until M7's real model lands, the candidate set is the seeded reverse-chron
 *  page (weights 'none', model 'reverse_chron' — O3's required literals). */
export async function buildSlateCore(
  env: Env,
  req: SlateRequest,
): Promise<{ slateId: string | null }> {
  const db = await pgFresh(env);
  try {
    const { rows: candidates } = await db.query<{ post_id: string }>(
      "select post_id from app.reverse_chron_page($1::uuid, $2, null::timestamptz, null::uuid, 200, $3::uuid)",
      [req.actorUserId ?? null, req.surface, req.actorUserId ?? null],
    );
    const { rows } = await db.query<{ id: string }>(
      "select app.write_reverse_chron_slate($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::uuid) as id",
      [
        req.actorUserId ?? null,
        req.actorAgentId ?? null,
        req.surface,
        // postgres.js serializes a JSON string as a jsonb *scalar*; pass the
        // array so it lands as a jsonb array (jsonb_array_length agrees).
        candidates.map((c) => ({ post_id: c.post_id })),
        900,
        req.actorUserId ?? null,
      ],
    );
    return { slateId: rows[0]?.id ?? null };
  } finally {
    await db.end();
  }
}

/** buildSlate() is the service-binding RPC — never a route (§9.21). */
export class SlateBuilder extends WorkerEntrypoint<Env> {
  async buildSlate(req: SlateRequest): Promise<{ slateId: string | null }> {
    return buildSlateCore(this.env, req);
  }
}

/** Queue-side: a `slate_build` job's payload, already claimed by the
 *  consumer skeleton — the surface + actor are all a build needs. */
export async function runSlateJob(env: Env, payload: SlateRequest): Promise<void> {
  await buildSlateCore(env, payload);
}
