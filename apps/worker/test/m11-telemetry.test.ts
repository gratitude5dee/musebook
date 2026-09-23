// apps/worker/test/m11-telemetry.test.ts (M11) — the consent / DSAR / alerting
// function surface §15.9–§15.11 + §16.6 define. Calls go through pgFresh(env)
// = musebook_worker, the only role holding SET privilege on the plane roles.
// RLS note: dsar_requests / consent_events / users are plane-gated, so plain
// table reads switch this connection's session role to the plane first —
// musebook_worker holds SET privilege on all three planes (pg_auth_members
// set_option), which is exactly what app.enter relies on inside the fns. The
// admin client can't see these rows at all under FORCE RLS.
import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { pgFresh } from "../src/db.js";
import { withDb, resetSeed, SEED_AUTHOR_ID } from "./helpers/db.js";

beforeEach(async () => {
  await resetSeed();
});

const jobs = async <T>(fn: (db: Awaited<ReturnType<typeof pgFresh>>) => Promise<T>) => {
  const db = await pgFresh(env as unknown as Env);
  try {
    return await fn(db);
  } finally {
    await db.end().catch(() => undefined);
  }
};

/** A kernel-plane read: session-level `set role` (no transaction needed —
 *  the worker role owns SET on every plane), then reset on the way out. */
const kernelSelect = <T>(sql: string) =>
  jobs(async (db) => {
    await db.query(`set role musebook_kernel`);
    await db.query(`select set_config('app.actor_id', '${SEED_AUTHOR_ID}', false)`);
    try {
      return await db.query<T>(sql);
    } finally {
      await db.query(`reset role`);
    }
  });

describe("app.record_consent_event", () => {
  it("writes the event and flips users.analytics_consent both directions", async () => {
    await jobs(async (db) => {
      const { rows: grant } = await db.query<{ id: string }>(
        `select app.record_consent_event($1, 'test-anon', 'analytics', false, 'test') as id`,
        [SEED_AUTHOR_ID],
      );
      expect(grant[0]?.id).toBeTruthy();
    });
    const { rows: off } = await kernelSelect<{ analytics_consent: boolean }>(
      `select analytics_consent from public.users where id = '${SEED_AUTHOR_ID}'`,
    );
    expect(off[0]?.analytics_consent).toBe(false);

    await jobs((db) =>
      db.query(`select app.record_consent_event($1, 'test-anon', 'analytics', true, 'test')`, [
        SEED_AUTHOR_ID,
      ]),
    );
    const { rows: on } = await kernelSelect<{ analytics_consent: boolean }>(
      `select analytics_consent from public.users where id = '${SEED_AUTHOR_ID}'`,
    );
    expect(on[0]?.analytics_consent).toBe(true);
    const { rows: evts } = await kernelSelect<{ n: number }>(
      `select count(*)::int as n from public.consent_events
        where user_id = '${SEED_AUTHOR_ID}' and source = 'test'`,
    );
    expect(evts[0]?.n).toBe(2);
  });

  it("records anon consent without touching any user row", async () => {
    await jobs((db) =>
      db.query(`select app.record_consent_event(null, 'test-anon-2', 'analytics', false, 'test')`),
    );
    const { rows } = await kernelSelect<{ n: number }>(
      `select count(*)::int as n from public.consent_events
        where anon_id = 'test-anon-2' and user_id is null`,
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe("the dsar lifecycle", () => {
  it("create → begin → collect → complete; the subject reads back its own row", async () => {
    await jobs(async (db) => {
      const { rows: created } = await db.query<{ id: string }>(
        `select app.create_dsar_request($1, null, 'export', 'test-export') as id`,
        [SEED_AUTHOR_ID],
      );
      const requestId = created[0]?.id;
      expect(requestId).toBeTruthy();

      // begin_dsar claims it once; a redelivery sees state='running' already.
      const { rows: begun } = await db.query<{ state: string; kind: string }>(
        `select kind, state from app.begin_dsar($1)`,
        [requestId],
      );
      expect(begun[0]?.kind).toBe("export");
      expect(begun[0]?.state).toBe("running");
      const { rows: rebegin } = await db.query<{ state: string }>(
        `select state from app.begin_dsar($1)`,
        [requestId],
      );
      expect(rebegin[0]?.state).toBe("running");

      const { rows: doc } = await db.query<{ doc: { user: { id: string } } }>(
        `select app.collect_dsar_export($1) as doc`,
        [SEED_AUTHOR_ID],
      );
      expect(doc[0]?.doc.user.id).toBe(SEED_AUTHOR_ID);
      expect(doc[0]?.doc).toHaveProperty("action_events");
      expect(doc[0]?.doc).toHaveProperty("dsar_requests");

      await db.query(`select app.complete_dsar($1, $2)`, [requestId, "dsar/test-export.json"]);
      const { rows: read } = await db.query<{
        state: string;
        artifact_key: string;
        completed_at: string | null;
      }>(`select state, artifact_key, completed_at from app.read_dsar_request($1, $2)`, [
        requestId,
        SEED_AUTHOR_ID,
      ]);
      expect(read[0]?.state).toBe("completed");
      expect(read[0]?.artifact_key).toBe("dsar/test-export.json");
      expect(read[0]?.completed_at).not.toBeNull();
    });
  });

  it("fail_dsar lands the request in 'refused' with the note", async () => {
    const requestId = await jobs(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `select app.create_dsar_request($1, null, 'delete', 'test-delete') as id`,
        [SEED_AUTHOR_ID],
      );
      await db.query(`select app.fail_dsar($1, 'test-identity-mismatch')`, [rows[0]?.id]);
      return rows[0]?.id;
    });
    const { rows } = await kernelSelect<{ state: string; note: string }>(
      `select state, note from public.dsar_requests where id = '${requestId}'`,
    );
    expect(rows[0]?.state).toBe("refused");
    expect(rows[0]?.note).toBe("test-identity-mismatch");
  });
});

describe("alerting", () => {
  it("evaluate_alerts writes its own heartbeat, so the cross-watch has data", async () => {
    // EXECUTE is owner-only by design — pg_cron runs it; the test calls it as
    // the table's owner, same as the gate's own fault injection.
    await withDb((c) => c.query(`select public.evaluate_alerts()`));
    const { rows } = await withDb((c) =>
      c.query<{ last_success_at: string | null }>(
        `select last_success_at from public.job_heartbeats where job = 'evaluate-alerts'`,
      ),
    );
    expect(rows[0]?.last_success_at).not.toBeNull();
  });

  it("a stale job_heartbeat latches firing_since on job.heartbeat_missing", async () => {
    await withDb(async (c) => {
      await c.query(
        `update public.job_heartbeats set last_success_at = now() - interval '2 days'
          where job = 'rollup-daily-pg'`,
      );
      await c.query(`select public.evaluate_alerts()`);
    });
    const { rows } = await withDb((c) =>
      c.query<{ firing_since: string | null }>(
        `select firing_since from public.alert_state where name = 'job.heartbeat_missing'`,
      ),
    );
    expect(rows[0]?.firing_since).not.toBeNull();
    // restore — alert state is shared with the gate's own fault injection.
    await withDb(async (c) => {
      await c.query(`update public.alert_state set firing_since = null`);
      await c.query(
        `update public.job_heartbeats set last_success_at = now()
          where job = 'rollup-daily-pg'`,
      );
    });
  });
});

describe("app.creator_dashboard", () => {
  it("exposes days_missing_ae so the rollup-lag badge has a source", async () => {
    const doc = await jobs(async (db) => {
      const { rows } = await db.query<{ doc: Record<string, unknown> }>(
        `select app.creator_dashboard($1) as doc`,
        [SEED_AUTHOR_ID],
      );
      return rows[0]?.doc;
    });
    expect(doc).toHaveProperty("days_missing_ae");
  });
});
