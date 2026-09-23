// packages/distributor/src/pipeline.ts — the per-channel variant loop.
// propose (LLM) -> validate -> repair (<= REFORMAT_MAX_REPAIRS) -> deterministic
// fallback (still validated; its failures are surfaced, never hidden).
import type { PlatformConstraint } from "./constraints";
import { deterministicVariant } from "./fallback";
import type { DistributorEnv } from "./postiz/client";
import type { VariantProposal } from "./reformat";
import { proposeVariant, type VariantIntent } from "./reformat";
import {
  validateVariant,
  type CandidateMedia,
  type VariantCandidate,
  type ValidatorReport,
} from "./validate";

export interface VariantResult {
  readonly candidate: VariantCandidate;
  readonly report: ValidatorReport;
  readonly generatedBy: "llm" | "deterministic" | "human";
  readonly rationale: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface PipelineInput {
  readonly canonicalMarkdown: string;
  /** Plain-text rendering for the deterministic path. */
  readonly plainBody: string;
  readonly canonicalUrl: string;
  readonly intent: VariantIntent;
  readonly constraint: PlatformConstraint;
  readonly platformRules: string | null;
  readonly media: readonly CandidateMedia[];
  /** Max LLM repair rounds after a failed first proposal (default 2; 0 = skip LLM). */
  readonly maxRepairs?: number;
}

function candidateFromProposal(
  p: VariantProposal,
  media: readonly CandidateMedia[],
  canonicalUrl: string,
): VariantCandidate {
  const picked = p.mediaIndexes
    .map((i) => media[i])
    .filter((m): m is CandidateMedia => m !== undefined)
    .map((m, i) => ({ ...m, alt: p.altText[i] ?? m.alt }));
  let body = p.body;
  if (p.hashtags.length > 0) {
    const tags = p.hashtags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");
    body = `${body}\n\n${tags}`;
  }
  return {
    body,
    threadParts: p.threadParts,
    media: picked,
    title: p.title,
    canonicalUrl,
  };
}

/**
 * One channel's full propose/validate/repair/fallback loop. Throws nothing for
 * a validation failure — the row still writes with is_valid=false (12.3.7:
 * the channel is excluded from the batch, loudly).
 */
export async function produceVariant(
  input: PipelineInput,
  env: DistributorEnv,
): Promise<VariantResult> {
  const maxRepairs = input.maxRepairs ?? Number.parseInt(env.REFORMAT_MAX_REPAIRS ?? "2", 10);

  if (maxRepairs > 0 && env.AI_GATEWAY_API_KEY) {
    let failures: readonly string[] | undefined;
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      try {
        const proposal = await proposeVariant(
          {
            canonicalMarkdown: input.canonicalMarkdown,
            canonicalUrl: input.canonicalUrl,
            intent: input.intent,
            constraint: input.constraint,
            platformRules: input.platformRules,
            media: input.media.map((m) => ({ url: m.url, contentType: m.contentType, alt: m.alt })),
            previousFailures: failures,
          },
          env,
        );
        const candidate = candidateFromProposal(proposal, input.media, input.canonicalUrl);
        const report = validateVariant(candidate, input.constraint);
        if (report.ok) {
          return {
            candidate,
            report,
            generatedBy: "llm",
            rationale: proposal.rationale,
            inputTokens: null,
            outputTokens: null,
          };
        }
        failures = report.failures;
      } catch {
        break; // gateway/model degraded -> deterministic path (12.4's degrade posture)
      }
    }
  }

  const candidate = deterministicVariant(
    { plainBody: input.plainBody, canonicalUrl: input.canonicalUrl, media: input.media },
    input.constraint,
  );
  const report = validateVariant(candidate, input.constraint);
  return {
    candidate,
    report,
    generatedBy: "deterministic",
    rationale: "deterministic full-port fallback (thread or truncate+link)",
    inputTokens: null,
    outputTokens: null,
  };
}
