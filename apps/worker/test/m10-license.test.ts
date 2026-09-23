// apps/worker/test/m10-license.test.ts — M10 gate checks 10 and 11 against
// the real local stack: creator_publishing_defaults inheritance through
// insert_draft_post (§10.10.3), and the action_events_daily re-key.
import { describe, expect, it } from "vitest";
import { withDb, SEED_AUTHOR_ID, SEED_POST_ID } from "./helpers/db.js";

const MARKDOWN = `# Licence fixture ${Date.now()}\n\nBody for the M10.10 check.`;

describe("M10.10 — licence inheritance from creator_publishing_defaults", () => {
  it("a draft posted with NULL licence fields carries the owner's CC0-1.0 + train_ai", async () => {
    await withDb(async (c) => {
      await c.query(
        `insert into public.creator_publishing_defaults
           (user_id, publish_mode, license_spdx, train_ai, ai_use, price_cents)
         values ($1, 'free', 'CC0-1.0', true, false, 0)
         on conflict (user_id) do update
           set license_spdx = 'CC0-1.0', train_ai = true, ai_use = false`,
        [SEED_AUTHOR_ID],
      );
    });
    try {
      const post = await withDb(async (c) => {
        // post_bodies_hash_matches demands hash === app.sha256_hex(markdown)
        // of the bytes actually inserted — ask the database for that value.
        const { rows: h } = await c.query<{ hash: string }>(
          "select app.sha256_hex($1::text) hash",
          [MARKDOWN],
        );
        const hash = h[0]!.hash;
        const { rows } = await c.query<{
          post_id: string;
          approval_id: string | null;
          job_id: number | null;
        }>(
          `select r.post_id, r.approval_id, r.job_id
             from public.insert_draft_post(
               $1::uuid, null::uuid, null::uuid, $2::text, $3::text, '{}'::text[],
               'free', false, null::uuid, null::uuid, '{musebook}'::text[],
               'license fixture', null, 'en',
               null::numeric, null::text, null::boolean, null::boolean, null::boolean) r`,
          [SEED_AUTHOR_ID, hash, MARKDOWN],
        );
        const { rows: posts } = await c.query<{
          license_spdx: string;
          train_ai: boolean;
        }>(`select license_spdx, train_ai from public.posts where id = $1`, [rows[0]!.post_id]);
        return posts[0]!;
      });
      expect(post.license_spdx).toBe("CC0-1.0");
      expect(post.train_ai).toBe(true);
    } finally {
      await withDb(async (c) => {
        await c.query(
          `update public.creator_publishing_defaults
             set license_spdx = 'CC-BY-4.0', train_ai = false
           where user_id = $1`,
          [SEED_AUTHOR_ID],
        );
      });
    }
  });
});

describe("M10.11 — action_events_daily re-keyed (day, actor_plane, source, post_id, action)", () => {
  it("the PK carries source, and two rows identical but for source coexist", async () => {
    await withDb(async (c) => {
      const { rows: pk } = await c.query<{ cols: string }>(
        `select string_agg(kcu.column_name, ',' order by kcu.ordinal_position) cols
           from pg_constraint con
           join information_schema.key_column_usage kcu
             on kcu.constraint_name = con.conname and kcu.table_schema = 'public'
          where con.conrelid = 'public.action_events_daily'::regclass
            and con.contype = 'p'`,
      );
      expect(pk[0]!.cols).toBe("day,actor_plane,source,post_id,action");

      const probe = (source: string) =>
        c.query(
          `insert into public.action_events_daily
           (day, actor_plane, source, post_id, action, n)
         values (current_date, 'human', $1, $2, 'view', 1)`,
          [source, SEED_POST_ID],
        );
      await probe("test_src_a");
      await probe("test_src_b");
      const { rows } = await c.query<{ n: string; total: string }>(
        `select count(*)::text n, sum(n)::text total
           from public.action_events_daily
          where day = current_date and actor_plane = 'human'
            and post_id = $1 and action = 'view'
            and source in ('test_src_a','test_src_b')`,
        [SEED_POST_ID],
      );
      expect(Number(rows[0]!.n)).toBe(2);
      expect(Number(rows[0]!.total)).toBe(2);
      await c.query(
        `delete from public.action_events_daily
          where action = 'view' and post_id = $1
            and source in ('test_src_a','test_src_b')`,
        [SEED_POST_ID],
      );
    });
  });
});
