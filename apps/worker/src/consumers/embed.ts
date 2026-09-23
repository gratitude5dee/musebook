// apps/worker/src/consumers/embed.ts — §9.23's embedding consumer. One batch
// of ≤100 claimed jobs maps 1:1 onto one batched embeddings call, which is
// why musebook-embed sits at max_batch_size 100 (§3.6.1, §4.13.2).
//
// The provider call is a plain fetch to the AI Gateway's OpenAI-compatible
// /v1/embeddings — the §9.23 UNVERIFIED note's safe fallback (ai@7.x on
// workerd is unproven); same batch semantics, nothing downstream changes.
import { claimJob, finishJob, pgFresh, retryDelaySeconds, type DbClient } from "../db.js";

export const BODY_CHAR_BUDGET = 12_000;

/** §8's BODY_CHAR_BUDGET — an embedding input is a body prefix, never a rewrite. */
export function truncateBody(markdown: string): string {
  return markdown.length <= BODY_CHAR_BUDGET
    ? markdown
    : `${markdown.slice(0, BODY_CHAR_BUDGET)}\n\n[truncated at ${BODY_CHAR_BUDGET} characters]`;
}

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/embeddings";

interface EmbedBatchMessage {
  job_id?: number | bigint;
}

function jobIdOf(msg: EmbedBatchMessage): number | null {
  const id = msg.job_id;
  if (typeof id === "bigint") return Number(id);
  return typeof id === "number" ? id : null;
}

/** One batched gateway call for the whole batch's texts; the dimension check
 *  lives here so a wrong EMBEDDING_MODEL/DIMENSIONS pairing fails loud on the
 *  first call instead of poisoning the index (§9.23's fails-fast). */
async function embedTexts(env: Env, texts: readonly string[]): Promise<number[][]> {
  const apiKey = env.AI_GATEWAY_API_KEY;
  if (apiKey === undefined) {
    throw new Error("embed: AI_GATEWAY_API_KEY not configured");
  }
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`embed: gateway returned ${res.status}`);
  }
  const body: { data: { embedding: number[] }[] } = await res.json();
  const dim = Number(env.EMBEDDING_DIMENSIONS);
  for (const d of body.data) {
    if (d.embedding.length !== dim) {
      throw new Error(`embedding dim ${d.embedding.length} != ${dim}`);
    }
  }
  return body.data.map((d) => d.embedding);
}

/**
 * Batch claim → table-is-cache dedupe → one gateway call → one batched
 * record_embeddings insert. §9.23 keeps the claim/succeed/ack semantics of
 * the shared skeleton; the difference is that the expensive side (the model
 * call) is batch-shaped, so this consumer takes the whole MessageBatch.
 */
export async function consumeEmbedBatch(batch: MessageBatch, env: Env): Promise<void> {
  const db: DbClient = await pgFresh(env);
  interface Claimed {
    msg: Message<unknown>;
    jobId: number;
    hash: string;
    postId: string;
  }
  const claimed: Claimed[] = [];
  try {
    // 1. CLAIM. Zero rows means another delivery already ran it: ack and move
    //    on — Queues is at-least-once with one active consumer per queue.
    for (const msg of batch.messages) {
      const body = msg.body as EmbedBatchMessage;
      const jobId = jobIdOf(body);
      if (jobId === null) {
        msg.ack();
        continue;
      }
      const job = await claimJob(db, jobId);
      if (job === null) {
        msg.ack();
        continue;
      }
      const hash = job.payload["content_hash"];
      const postId = job.payload["post_id"];
      if (typeof hash !== "string" || typeof postId !== "string") {
        await finishJob(db, jobId, "dead", {
          component: "embed",
          event: "bad_payload",
          error: "payload missing content_hash/post_id",
        });
        msg.ack();
        continue;
      }
      claimed.push({ msg, jobId, hash, postId });
    }
    if (claimed.length === 0) {
      return;
    }

    // 2. The TABLE is the cache (spine invariant 1): an existing row means
    //    this exact body is already embedded, whatever the queue thinks.
    const hashes = [...new Set(claimed.map((c) => c.hash))];
    const { rows: done } = await db.query<{ content_hash: string }>(
      "select content_hash from app.existing_embeddings($1)",
      [hashes],
    );
    const doneSet = new Set(done.map((r) => r.content_hash));
    const todo = claimed.filter((c) => !doneSet.has(c.hash));

    if (todo.length > 0) {
      // 3. Bodies from post_bodies (kernel-plane — app.embed_post_bodies is the
      //    definer capability), truncated to §8's budget, one batched call.
      const { rows: bodies } = await db.query<{
        content_hash: string;
        canonical_markdown: string;
      }>("select content_hash, canonical_markdown from app.embed_post_bodies($1)", [
        [...new Set(todo.map((c) => c.hash))],
      ]);
      const postIdFor = new Map(todo.map((c) => [c.hash, c.postId]));
      const embeddings = await embedTexts(
        env,
        bodies.map((b) => truncateBody(b.canonical_markdown)),
      );
      const dim = Number(env.EMBEDDING_DIMENSIONS);
      const rows = bodies.map((b, i) => ({
        content_hash: b.content_hash,
        post_id: postIdFor.get(b.content_hash) ?? null,
        model: env.EMBEDDING_MODEL,
        dim,
        embedding: `[${(embeddings[i] ?? []).join(",")}]`,
      }));
      // Driver-portable bind: node-postgres sends the JSON string as text
      // (it would serialize a raw object array as a Postgres array literal),
      // and the $1::text hint stops postgres.js from re-quoting the value —
      // both arrive as text the inner cast then parses to a jsonb array.
      await db.query("select app.record_embeddings(($1::text)::jsonb)", [JSON.stringify(rows)]);
    }

    // 4. Mark done + ack. Rows already embedded land here too — redelivery
    //    semantics are "at most one effect", not "retry until novel".
    for (const c of claimed) {
      await finishJob(db, c.jobId, "succeeded", { component: "embed" });
      c.msg.ack();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    for (const c of claimed) {
      await finishJob(db, c.jobId, "failed", {
        component: "embed",
        event: "consumer_error",
        error,
      }).catch(() => undefined);
      c.msg.retry({ delaySeconds: retryDelaySeconds(c.msg.attempts) });
    }
    throw err;
  } finally {
    await db.end();
  }
}
