// apps/edge/src/routes/channels-sync.ts — POST /api/channels/sync (§12.2.7).
// One shared Postiz organisation means listIntegrations() returns EVERY
// creator's channels: the merge happens inside app.sync_postiz_channels, which
// leaves rows owned by another owner alone and attributes only unclaimed ids
// to the caller. channels.platform is rewritten on every sync because a
// provider migration (tiktok -> tiktok-business) mutates `identifier` under us.
// New channels get ONE integration-settings fetch merged into the
// channel_constraint_overrides cache; the weekly cron refreshes the rest.
import { postizClient, type DistributorEnv } from "@musebook/distributor";
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { fresh } from "../db/client.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

interface SyncResult {
  claimed: number;
  updated: number;
  skipped: number;
  new_channels: { channel_id: string; postiz_channel_id: string }[];
}

export async function handleChannelsSync(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "human_creator" || actor.userId === null) {
    return json({ error: "forbidden" }, 403);
  }
  const owner = actor.userId;

  const client = postizClient(env as unknown as DistributorEnv);
  const integrations = await client.listIntegrations().catch(() => null);
  if (integrations === null) return json({ error: "postiz_unreachable" }, 502);

  const items = integrations
    .filter((ig) => ig.disabled !== true)
    .map((ig) => ({
      postiz_channel_id: ig.id,
      platform: ig.identifier,
      handle: ig.profile ?? null,
      display_name: ig.name,
      avatar_url: ig.picture ?? null,
    }));

  const db = fresh(env);
  try {
    const { rows } = await db.query<{ result: SyncResult }>(
      "select app.sync_postiz_channels($1::uuid, $2::jsonb) as result",
      [owner, JSON.stringify(items)],
    );
    const result = rows[0]?.result;
    if (result === undefined) throw new Error("sync_postiz_channels returned nothing");

    // Step 4: one live settings fetch per NEW channel — merge maxLength and
    // the @Rules blob into the constraint cache the validator reads.
    await Promise.all(
      result.new_channels.map(async ({ channel_id, postiz_channel_id }) => {
        const settings = await client.integrationSettings(postiz_channel_id).catch(() => null);
        if (settings === null) return;
        const s = settings as {
          additionalSettings?: { maxLength?: number; rules?: string }[];
        };
        const maxLength =
          s.additionalSettings?.find((a) => typeof a.maxLength === "number")?.maxLength ?? null;
        const rules = s.additionalSettings?.find((a) => typeof a.rules === "string")?.rules ?? null;
        await db.query("select app.channel_constraint_upsert($1::uuid, $2, $3, $4::jsonb)", [
          channel_id,
          maxLength,
          rules,
          JSON.stringify(settings),
        ]);
      }),
    );

    return json({
      claimed: result.claimed,
      updated: result.updated,
      skipped: result.skipped,
    });
  } finally {
    await db.end().catch(() => undefined);
  }
}
