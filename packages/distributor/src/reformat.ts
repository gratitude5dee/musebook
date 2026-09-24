// packages/distributor/src/reformat.ts — §12.3.4 verbatim.
// Vercel AI SDK generateObject through Vercel AI Gateway (AI_GATEWAY_API_KEY);
// the only generation call in this section — one call PER PLATFORM.
import { generateObject } from "ai"; // ai@7
import { z } from "zod"; // zod@4.x line (isolated resolution)
import type { PlatformConstraint } from "./constraints";
import type { DistributorEnv } from "./postiz/client";

export type VariantIntent = "full" | "teaser";

export const variantProposal = z.object({
  /** value[0]. Already in the platform's editor dialect. */
  body: z.string(),
  /** value[1..n]. Empty when the platform does not support threads. */
  threadParts: z.array(z.string()),
  /** Indices into the caller's media list, in publish order. */
  mediaIndexes: z.array(z.number().int().min(0)),
  /** Alt text, parallel to mediaIndexes. */
  altText: z.array(z.string()),
  /** Bare words, no leading '#'. The formatter places them. */
  hashtags: z.array(z.string()),
  /** youtube/reddit/pinterest title, null elsewhere. */
  title: z.string().nullable(),
  /** One sentence for the preview UI, explaining what was cut. */
  rationale: z.string(),
});
export type VariantProposal = z.infer<typeof variantProposal>;

export interface ProposeInput {
  readonly canonicalMarkdown: string;
  readonly canonicalUrl: string;
  readonly intent: VariantIntent;
  readonly constraint: PlatformConstraint;
  /** The @Rules string from GET /public/v1/integration-settings/:id, if cached. */
  readonly platformRules: string | null;
  /** cdn.musebook.dev URLs only — see 12.2.5. */
  readonly media: readonly { url: string; contentType: string; alt: string | null }[];
  /** Populated on a repair attempt with the failing checks. */
  readonly previousFailures?: readonly string[] | undefined;
}

function systemPrompt(c: PlatformConstraint, rules: string | null): string {
  return [
    `You rewrite one piece of writing for ${c.displayName}. You do not invent facts,`,
    `you do not add claims, and you do not change the author's meaning or voice.`,
    ``,
    `HARD LIMITS (a proposal that violates one is discarded by a deterministic`,
    `validator and you will be asked again, so respect them the first time):`,
    `- Body length: at most ${c.maxChars} ${
      c.countMethod === "utf8_bytes"
        ? "UTF-8 bytes"
        : c.countMethod === "graphemes"
          ? "grapheme clusters"
          : c.countMethod === "x_weighted"
            ? "weighted units (a URL always costs 23)"
            : "UTF-16 code units"
    }.`,
    `- Output dialect: ${
      c.editor === "html"
        ? "HTML using only <p> <br> <b> <i> <u> <a> <ul> <ol> <li>"
        : c.editor === "markdown"
          ? "CommonMark"
          : "plain text, no markup"
    }.`,
    c.supportsThreads
      ? `- Threads allowed: up to ${c.maxThreadParts ?? 25} parts, each within the limit.`
      : `- Threads NOT supported: threadParts MUST be [].`,
    c.maxHashtags === null
      ? `- Hashtags: use sparingly or not at all.`
      : `- Hashtags: at most ${c.maxHashtags}, style "${c.hashtagStyle}".`,
    c.requiresAltText
      ? `- Alt text is REQUIRED for every attached image.`
      : `- Alt text is optional but strongly preferred.`,
    `- Attachments: at least ${c.minMedia}, at most ${c.maxImages} image(s) and ${c.maxVideos} video(s).`,
    `  Pick mediaIndexes accordingly; drop media rather than exceed a cap.`,
    `  Structured media rules: ${JSON.stringify(c.mediaRules)}.`,
    c.maxTitleChars === null
      ? `- title MUST be null.`
      : `- title: 2 to ${c.maxTitleChars} characters, required.`,
    ``,
    `PLATFORM RULES (verbatim, from the publishing backend):`,
    rules ?? "(none cached)",
  ].join("\n");
}

export async function proposeVariant(
  input: ProposeInput,
  env: DistributorEnv,
): Promise<VariantProposal> {
  const { object } = await generateObject({
    // Gateway-routed slug, from Worker [vars]. NEVER hardcode — see 12.4.
    model: env.REFORMAT_MODEL ?? "anthropic/claude-sonnet-5",
    schema: variantProposal,
    temperature: 0.3,
    maxRetries: 2,
    system: systemPrompt(input.constraint, input.platformRules),
    prompt: [
      input.intent === "teaser"
        ? // Retained but unreachable under CF-SPINE §13.3; see variantIntentFor.
          `Write a TEASER. The full piece is paywalled. Do NOT reproduce the body; ` +
          `write a hook that makes someone click, and end with the URL.`
        : `Rewrite the piece in full for this platform. This is a FULL PORT: ` +
          `carry the whole argument across, do not summarise, do not tease. ` +
          `Keep the author's voice. If the piece cannot fit within the hard ` +
          `limits, use a thread (where supported) rather than cutting; only ` +
          `truncate when threads are not an option, and always end with the ` +
          `canonical URL.`,
      ``,
      `CANONICAL URL (must appear verbatim in the output): ${input.canonicalUrl}`,
      ``,
      `SOURCE:`,
      input.canonicalMarkdown,
      ``,
      `MEDIA AVAILABLE (${input.media.length} item(s); return indices in publish order):`,
      ...input.media.map((m, i) => `[${i}] ${m.contentType} ${m.url} alt=${m.alt ?? "(none)"}`),
      ...(input.previousFailures !== undefined && input.previousFailures.length > 0
        ? [
            ``,
            `YOUR PREVIOUS ATTEMPT FAILED THESE CHECKS. Fix all of them:`,
            ...input.previousFailures.map((f) => `- ${f}`),
          ]
        : []),
    ].join("\n"),
  });
  return object;
}
