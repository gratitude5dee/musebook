// apps/worker/src/cron/refresh-channel-constraints.ts — §12.3.1's weekly
// refresh: Postiz resolves a channel's live limits server-side (the Verified
// flag, provider changes, settings edits), so overrides are re-read every
// Monday 04:00 rather than trusted from the platforms seed.
import { postizClient, type DistributorEnv } from "@musebook/distributor";
import { jobsTx, pgFresh } from "../db.js";

const MAX_CHANNELS_PER_TICK = 50;

interface SyncableChannel {
  id: string;
  postiz_channel_id: string;
}

/** GET /integration-settings/:id returns { output: { rules, maxLength,
 *  settings, tools } } — maxLength is already resolved against the channel's
 *  Verified flag (12.3.1). Loose shape: the route's DTOs drift upstream. */
function parseSettings(raw: unknown): {
  maxChars: number | null;
  rulesText: string | null;
  settingsSchema: unknown;
  tools: unknown;
} {
  const out =
    raw !== null && typeof raw === "object"
      ? ((raw as { output?: Record<string, unknown> }).output ?? (raw as Record<string, unknown>))
      : {};
  const maxLength = out.maxLength;
  const rules = out.rules;
  return {
    maxChars: typeof maxLength === "number" ? maxLength : null,
    rulesText:
      typeof rules === "string" ? rules : rules === undefined ? null : JSON.stringify(rules),
    settingsSchema: out.settings ?? null,
    tools: out.tools ?? [],
  };
}

export async function refreshChannelConstraints(env: Env): Promise<void> {
  if ((env as { DISTRIBUTION_ENABLED?: string }).DISTRIBUTION_ENABLED !== "true") {
    return;
  }
  const db = await pgFresh(env);
  try {
    const { rows: channels } = await jobsTx(db, async () =>
      db.query<SyncableChannel>(
        `select c.id::text, c.postiz_channel_id
         from public.channels c
        where c.disabled_at is null
        order by c.connected_at
        limit $1`,
        [MAX_CHANNELS_PER_TICK],
      ),
    );
    let client: ReturnType<typeof postizClient> | null = null;
    const getClient = () => (client ??= postizClient(env as unknown as DistributorEnv));
    for (const ch of channels) {
      let raw: unknown;
      try {
        raw = await getClient().integrationSettings(ch.postiz_channel_id);
      } catch {
        continue; // a missing/errored integration keeps its last overrides
      }
      const s = parseSettings(raw);
      await jobsTx(db, async () => {
        await db.query(
          `insert into public.channel_constraint_overrides
           (channel_id, max_chars, rules_text, settings_schema, tools, refreshed_at)
         values ($1::uuid, $2, $3, ($4::text)::jsonb, ($5::text)::jsonb, now())
         on conflict (channel_id) do update set
           max_chars = excluded.max_chars, rules_text = excluded.rules_text,
           settings_schema = excluded.settings_schema, tools = excluded.tools,
           refreshed_at = excluded.refreshed_at`,
          [
            ch.id,
            s.maxChars,
            s.rulesText,
            JSON.stringify(s.settingsSchema),
            JSON.stringify(s.tools),
          ],
        );
      });
    }
  } finally {
    await db.end();
  }
}
