// apps/mcp/src/tools/submit-post.ts — §7.4 tool 10: submit a draft, an
// intent, or publish straight through. post:write always; post:publish when
// publish:true or access!=open. RequiresApproval delegations land
// pending_approval — the same bridge row the human approves from (§7.10).
import type { McpServer } from "@modelcontextprotocol/server";
import { canonicalMarkdown, contentHash } from "@musebook/content";
import { accessToPublishMode } from "@musebook/kernel";
import { fresh, release } from "../db/client.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { recordAgentEvent } from "../telemetry.js";
import { requireScope, errorResult } from "./shared.js";
import { submitPostInput } from "./schemas.js";

interface SubmitResult {
  post_id: string;
  approval_id: string | null;
  job_id: string;
}

export function registerSubmitPost(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "submit_post",
    {
      title: "Submit a post, paid intent, or publish",
      description:
        "Submit a post body. publish:false lands a draft the human approves on musebook.dev " +
        "(post:write). publish:true or access != 'open' needs post:publish. Priced submissions are " +
        "INTENTS: they land pending_approval with a spend reservation, and the manifest " +
        "constraints are the approval envelope — this tool never reorders them.",
      inputSchema: submitPostInput,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const denied = requireScope(actor, "post:write");
      if (denied !== null) return denied;
      if (actor.class !== "owner_agent")
        return errorResult("unauthenticated", "A delegation is required.");

      const wantsPaid = args.access !== "open";
      if (wantsPaid || args.publish) {
        const deniedPublish = requireScope(actor, "post:publish");
        if (deniedPublish !== null) return deniedPublish;
      }
      if (wantsPaid && args.price_atomic === undefined) {
        return errorResult("missing_price", "Priced intent requires price_atomic > 0.");
      }

      const sql = fresh(env);
      try {
        const canonical = canonicalMarkdown(args.body_markdown);
        const hash = contentHash(canonical);
        const pending = !args.publish || wantsPaid || actor.requiresApproval;
        const rows = (await sql.unsafe(
          `select * from public.insert_draft_post(
             $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text[],
             $7::text, $8::boolean, $9::uuid, $10::uuid,
             $11::text[], $12::text, $13::text, $14::text,
             $15::numeric(78,0), $16::text)`,
          [
            actor.userId,
            actor.agentIdentityId,
            actor.delegationId,
            hash,
            canonical,
            args.tags,
            accessToPublishMode(args.access),
            pending,
            null, // schedule_id — scheduled_for intents land via the job row
            null,
            ["musebook"],
            args.title ?? null,
            args.summary ?? null,
            args.language_code,
            args.price_atomic ?? null,
            args.license_spdx ?? null,
          ],
        )) as SubmitResult[];
        const r = rows[0];
        if (r === undefined)
          return errorResult("submit_failed", "insert_draft_post returned nothing.");

        recordAgentEvent(env, ctx, {
          actor,
          tool: "submit_post",
          outcome: "ok",
          postId: r.post_id,
          contentHash: hash,
        });
        const body = {
          status: pending ? "pending_approval" : "published",
          post_id: r.post_id,
          approval_id: r.approval_id,
          job_id: r.job_id,
          content_hash: hash,
          intent: wantsPaid,
          bridge_url:
            r.approval_id !== null ? `https://musebook.dev/bridge/${r.approval_id}` : null,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(body) }],
          structuredContent: body,
        };
      } finally {
        release(ctx, sql);
      }
    },
  );
}
