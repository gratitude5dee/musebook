// packages/classify/src/battery.ts
import { choice, noul, score } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";

/** Cross-cutting subject matter. Orthogonal to the taxonomy in §8.5, which asks
 *  "what kind of thing is this"; these ask "what is it about". */
export const TOPIC_TAGS = [
  "ai_ml",
  "agents_tooling",
  "web3_crypto",
  "software_dev",
  "design_ux",
  "music_audio",
  "film_video",
  "visual_art",
  "writing_publishing",
  "games_interactive",
  "science_research",
  "business_creator",
] as const;
export type TopicTag = (typeof TOPIC_TAGS)[number];

export const AUDIENCE_LEVELS = [
  "No background needed; a general audience follows it end to end.",
  "Some familiarity with the field's vocabulary is assumed.",
  "Practitioner level; assumes hands-on experience with the tools discussed.",
  "Specialist; assumes research-level or deep-internals knowledge.",
] as const;

export const QUALITY_LEVELS = [
  "Broken, empty, truncated or unreadable.",
  "Thin: states something but adds nothing a reader could not guess.",
  "Competent and complete on its own terms.",
  "Notably good: specific, well produced, worth resurfacing months later.",
] as const;

export const AGENT_VALUE_LEVELS = [
  "Nothing an agent could reuse; pure chatter or navigation.",
  "Restates common knowledge already present in any trained model.",
  "Contains specific facts, numbers, code or steps an agent could act on.",
  "Primary, hard-to-find material: original data, working code, or a reproducible procedure.",
] as const;

const tag = (label: string, what: string) =>
  noul(`Is this post substantially about ${what}?`, {
    true: "The post covers this in a meaningful way, not in passing.",
    false: `The subject is absent, or "${label}" is only mentioned once.`,
  });

export const POST_BATTERY = {
  // ---- level-1 taxonomy root; levels 2 and 3 are the walk in §8.6 ----
  taxonomy_l1: choice(
    {
      task: "Which top-level category does this post belong to?",
      rule: "Judge the primary payload, not the framing or the caption.",
    },
    {
      media: "A finished creative work to be watched, heard, looked at or read.",
      apps: "Something runnable: an agent, a web application, or a developer tool.",
      artifacts: "A reusable asset: a 3D model, an onchain contract, or a dataset.",
      none_of_these: "None of the three apply.",
    },
  ),

  // ---- medium / format ----
  medium: choice(
    {
      task: "Which single medium best describes the primary payload?",
      tie_break: "Prefer the payload the post is about over decoration or thumbnails.",
    },
    {
      video: "A moving-image file is the main payload.",
      audio: "An audio file with no primary moving image.",
      image: "One or more still images.",
      text: "Prose, article or thread; media is decorative or absent.",
      app: {
        summary: "An interactive, runnable application or agent.",
        examples: ["a deployed web app", "an MCP server", "a CLI"],
      },
      artifact_3d: "A 3D scene, mesh, GLB/USDZ or WebXR experience.",
      dataset: "A structured data file, model weights, or a benchmark.",
      mixed: "Several media carry the post equally.",
      none_of_these: "No identifiable payload.",
    },
  ),

  tone: choice("What register does the post use?", {
    explainer: "Teaches or walks through something.",
    technical: "Assumes and uses precise domain vocabulary.",
    news: "Reports an event or an announcement.",
    personal: "First-person reflection or diary.",
    promotional: "Sells, launches or advertises.",
    hype: "Excited superlatives with little substance.",
    shitpost: "Deliberately unserious.",
    other: "None of the above registers.",
  }),

  language: choice("What is the dominant natural language of the title, summary and body?", {
    en: null,
    es: null,
    pt: null,
    fr: null,
    de: null,
    it: null,
    ja: null,
    ko: null,
    zh: null,
    hi: null,
    ar: null,
    ru: null,
    other: "A natural language not listed above.",
    none: "No natural-language text at all.",
  }),

  // ---- ordered rubrics: the `score` return value is a usable continuous feature ----
  audience_level: score(
    "How much prior domain knowledge does a reader need to follow this post?",
    AUDIENCE_LEVELS,
  ),
  quality: score("How well made is this post on its own terms?", QUALITY_LEVELS),
  agent_value: score(
    {
      task: "How useful would this post be to an autonomous agent that paid to crawl it?",
      note: "Judge durable, extractable information. Ignore popularity and ignore how well written it is.",
    },
    AGENT_VALUE_LEVELS,
  ),

  // ---- independent flags: one noul each ----
  unsafe: noul(
    "Does the post contain sexual content involving minors, credible threats, doxxing, or instructions for causing serious physical harm?",
  ),
  nsfw: noul("Is this post sexually explicit, or graphically violent?", {
    true: "Explicit sexual content or graphic gore.",
    false: "Nothing a general audience would need warned about.",
  }),
  brand_unsafe: noul("Would a mainstream advertiser refuse to appear beside this post?", {
    true: "Hate, graphic violence, adult content, hard drugs, gambling, or sustained abuse of a person.",
    false: "Ordinary content an advertiser would tolerate.",
  }),
  toxic: noul("Does the post attack, demean or harass a person or a group?"),
  spam: noul("Is this engagement bait, an unsolicited advertisement, or a scam?"),
  commercial_intent: noul("Is the post trying to make the reader buy or sign up for something?"),
  ai_generated: noul("Was the primary media or prose produced by a generative model?", {
    true: "Synthesised media or prose, including heavy model assistance.",
    false: "Captured, drawn, written or performed by a person without generative synthesis.",
  }),
  discloses_ai: noul("Does the post itself state that it is AI-generated?"),
  contains_pii: noul(
    "Does the post expose a private individual's contact details, home address, or government ID?",
  ),

  // ---- topic tags: one noul per vocabulary entry (Jev has no multi-label type) ----
  tag_ai_ml: tag("ai_ml", "machine learning models, training, or AI research"),
  tag_agents_tooling: tag("agents_tooling", "autonomous agents, MCP, or agent tooling"),
  tag_web3_crypto: tag("web3_crypto", "blockchains, tokens, or onchain applications"),
  tag_software_dev: tag("software_dev", "writing, shipping or operating software"),
  tag_design_ux: tag("design_ux", "visual design, interface design or user experience"),
  tag_music_audio: tag("music_audio", "music, sound design or audio production"),
  tag_film_video: tag("film_video", "film, video production or moving image work"),
  tag_visual_art: tag("visual_art", "illustration, photography or visual art"),
  tag_writing_publishing: tag("writing_publishing", "writing craft, publishing or newsletters"),
  tag_games_interactive: tag("games_interactive", "games or interactive experiences"),
  tag_science_research: tag("science_research", "scientific research or published findings"),
  tag_business_creator: tag("business_creator", "business, markets or the creator economy"),
} as const;

/** Compile-time guard: every TOPIC_TAGS entry has a matching question. */
type UncoveredTag = Exclude<`tag_${TopicTag}`, keyof typeof POST_BATTERY>;
const _allTagsCovered: UncoveredTag extends never ? true : never = true;
void _allTagsCovered;

/** The 16 non-tag questions, split for the §8.4 question-count fallback. */
export type LabelKey = Exclude<keyof typeof POST_BATTERY, `tag_${string}`>;
export type TagKey = Extract<keyof typeof POST_BATTERY, `tag_${string}`>;

export const POST_BATTERY_LABELS = Object.fromEntries(
  Object.entries(POST_BATTERY).filter(([k]) => !k.startsWith("tag_")),
) as unknown as Pick<typeof POST_BATTERY, LabelKey>;

export const POST_BATTERY_TAGS = Object.fromEntries(
  Object.entries(POST_BATTERY).filter(([k]) => k.startsWith("tag_")),
) as unknown as Pick<typeof POST_BATTERY, TagKey>;

/**
 * Cache and re-classification key. JSON.stringify preserves insertion order for
 * string keys, so this is stable across processes for an unchanged source file.
 * Changing ANY instruction, label or rubric level changes this hash — which is
 * the point: it is what tells the backfill job what is stale.
 *
 * node:crypto createHash, not WebCrypto, and this is a workerd decision rather
 * than a taste one: node:crypto is fully supported on workerd with NO
 * compatibility flag (CF-SPINE §12), and createHash is SYNCHRONOUS.
 * subtle.digest returns a Promise, and Workers do not permit top-level await,
 * so it could not produce a module-scope constant at all.
 */
export const QUESTION_SET_VERSION = createHash("sha256")
  .update(JSON.stringify(POST_BATTERY))
  .digest("hex")
  .slice(0, 16);
