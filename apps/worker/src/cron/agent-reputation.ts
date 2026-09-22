// apps/worker/src/cron/agent-reputation.ts — §10.10.4's nightly pass on
// '17 3 * * *': for every active delegation, compute the rate inputs over the
// trailing 30 days in ONE helper call, fold them through the pure
// nextReputation(), and write the bounded score back.
import { nextReputation, type ReputationInputs } from "@musebook/connectors";
import { pgFresh } from "../db.js";

export async function recomputeReputation(env: Env): Promise<void> {
  const db = await pgFresh(env);
  try {
    const { rows: delegations } = await db.query<{
      delegation_id: string;
      reputation: string;
    }>("select * from app.delegations_for_reputation()");

    for (const d of delegations) {
      const { rows } = await db.query<{
        reputation_inputs_for: Omit<ReputationInputs, "previous">;
      }>("select app.reputation_inputs_for($1::uuid, 30)", [d.delegation_id]);
      const inputs = rows[0]?.reputation_inputs_for;
      if (!inputs) continue;
      const score = nextReputation({ ...inputs, previous: Number(d.reputation) });
      if (score !== Number(d.reputation)) {
        await db.query("select app.set_delegation_reputation($1::uuid, $2::numeric)", [
          d.delegation_id,
          score.toString(),
        ]);
      }
    }
  } finally {
    await db.end();
  }
}
