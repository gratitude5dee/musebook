// apps/worker/scripts/m17-comparison.mts — the M17 gate's live probes.
// Runs the production propose/validate/repair/fallback path (produceVariant)
// against a held-out corpus and real platform rows from the local Supabase,
// plus a counter-parity sweep over every platform row and a full-ports sweep.
// Invoked by scripts/gates/checks.mjs.
//
//   tsx scripts/m17-comparison.mts comparison   — LLM vs deterministic, writes .gate/m17-comparison.json
//   tsx scripts/m17-comparison.mts parity       — counter parity over all platform rows
//   tsx scripts/m17-comparison.mts ports        — deterministicVariant full-ports on every row
//   tsx scripts/m17-comparison.mts release      — release_agent_spend returns a reservation
import pg from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  countEffective,
  deterministicVariant,
  produceVariant,
  toConstraint,
  validateVariant,
  type PipelineInput,
} from "@musebook/distributor";
import type { CandidateMedia } from "@musebook/distributor/validate";

const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const CDN_HOST = "cdn.musebook.dev";
const CANONICAL_URL = "https://musebook.dev/p/m17-held-out";

const img = (i: number, alt: string | null = `image ${i}`): CandidateMedia => ({
  url: `${CDN_HOST_URL}/t/i${i}.png`,
  contentType: "image/png",
  alt,
  widthPx: 800,
  heightPx: 600,
  durationSeconds: null,
  thumbnailUrl: null,
});
const CDN_HOST_URL = `https://${CDN_HOST}`;
const VID: CandidateMedia = {
  url: `${CDN_HOST_URL}/t/clip.mp4`,
  contentType: "video/mp4",
  alt: "clip",
  widthPx: 1280,
  heightPx: 720,
  durationSeconds: 30,
  thumbnailUrl: `${CDN_HOST_URL}/t/clip.jpg`,
};

const LONG_BODY = Array.from(
  { length: 14 },
  (_, i) =>
    `Paragraph ${i + 1}. The release candidate survived a week of soak time and the dashboards stayed flat through two traffic spikes.`,
).join(" ");

const ESSAY_MD = [
  "# Why the scheduler moved to Postgres",
  "",
  "The old queue was fine until it wasn't. This post walks through the failure mode,",
  "the migration, and the numbers. " + LONG_BODY,
].join("\n");

interface HeldOutCase {
  readonly name: string;
  readonly platform: string;
  readonly markdown: string;
  readonly plain: string;
  readonly media: readonly CandidateMedia[];
  /** cases the deterministic path cannot satisfy but a competent model can. */
  readonly llmShouldWin: boolean;
}

const CASES: readonly HeldOutCase[] = [
  // --- designed LLM wins: mechanical fallback cannot satisfy the constraint
  {
    name: "x-6-images",
    platform: "x",
    markdown: "Launch day — six screenshots of the new console.",
    plain: "Launch day — six screenshots of the new console.",
    media: [img(0), img(1), img(2), img(3), img(4), img(5)],
    llmShouldWin: true, // det emits all 6 (>4); the model picks <=4
  },
  {
    name: "x-image-plus-video",
    platform: "x",
    markdown: "Demo clip and a still from the same build.",
    plain: "Demo clip and a still from the same build.",
    media: [img(0), VID],
    llmShouldWin: true, // det mixes image+video (x: images OR one video)
  },
  {
    name: "pinterest-no-alt",
    platform: "pinterest",
    markdown: "Three shots of the finished mural.",
    plain: "Three shots of the finished mural.",
    media: [img(0, null), img(1, null), img(2, null)],
    llmShouldWin: true, // det cannot conjure alt text
  },
  {
    name: "youtube-tiny-body",
    platform: "youtube",
    markdown: "🔥",
    plain: "🔥",
    media: [VID],
    llmShouldWin: true, // det's 8-word title = 1 char < 2; the model writes one
  },
  // --- baselines both paths pass
  {
    name: "x-plain",
    platform: "x",
    markdown: "Shipping the M17 gate today; changelog inside.",
    plain: "Shipping the M17 gate today; changelog inside.",
    media: [],
    llmShouldWin: false,
  },
  {
    name: "threads-long",
    platform: "threads",
    markdown: LONG_BODY,
    plain: LONG_BODY,
    media: [],
    llmShouldWin: false,
  },
  {
    name: "devto-essay",
    platform: "devto",
    markdown: ESSAY_MD,
    plain: ESSAY_MD.replace(/[#>*_`~-]/g, "").replace(/\n{3,}/g, "\n\n"),
    media: [],
    llmShouldWin: false,
  },
  {
    name: "slack-note",
    platform: "slack",
    markdown: "Deploy finished — metrics look clean.",
    plain: "Deploy finished — metrics look clean.",
    media: [img(0), img(1)],
    llmShouldWin: false,
  },
];

async function loadConstraints(slugs?: readonly string[]) {
  const db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      `select * from public.platforms ${slugs ? "where slug = any($1::text[])" : ""} order by slug`,
      slugs ? [slugs] : [],
    );
    return new Map(rows.map((r) => [r.slug as string, toConstraint(r, { cdnHost: CDN_HOST })]));
  } finally {
    await db.end();
  }
}

async function comparison() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.log("COMPARISON_BLOCKED AI_GATEWAY_API_KEY unset (H15)");
    return;
  }
  const constraints = await loadConstraints(CASES.map((c) => c.platform));
  const envLlm = {
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    REFORMAT_MODEL: process.env.REFORMAT_MODEL ?? "anthropic/claude-sonnet-5",
    REFORMAT_MAX_REPAIRS: "2",
  };
  const envDet = { ...envLlm, REFORMAT_MAX_REPAIRS: "0" };

  const results = [];
  for (const c of CASES) {
    const constraint = constraints.get(c.platform);
    if (!constraint) throw new Error(`platform ${c.platform} not seeded`);
    const input: PipelineInput = {
      canonicalMarkdown: c.markdown,
      plainBody: c.plain,
      canonicalUrl: CANONICAL_URL,
      intent: "full",
      constraint,
      platformRules: null,
      media: c.media,
    };
    const [llm, det] = await Promise.all([
      produceVariant(input, envLlm),
      produceVariant(input, envDet),
    ]);
    results.push({
      name: c.name,
      platform: c.platform,
      llm_should_win: c.llmShouldWin,
      llm: {
        generated_by: llm.generatedBy,
        ok: llm.report.ok,
        failures: llm.report.failures,
      },
      deterministic: { ok: det.report.ok, failures: det.report.failures },
    });
    console.log(
      `case ${c.name} (${c.platform}): llm=${llm.report.ok ? "PASS" : "FAIL"} ` +
        `[${llm.generatedBy}] det=${det.report.ok ? "PASS" : "FAIL"}`,
    );
  }

  const llmPass = results.filter((r) => r.llm.ok).length;
  const detPass = results.filter((r) => r.deterministic.ok).length;
  const verdict = llmPass > detPass;

  const out = {
    ranAt: new Date().toISOString(),
    model: envLlm.REFORMAT_MODEL,
    cases: results,
    llm: { n: results.length, pass: llmPass },
    deterministic: { n: results.length, pass: detPass },
    verdict,
  };
  const gateDir = join(process.cwd(), "..", "..", ".gate");
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(join(gateDir, "m17-comparison.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(
    verdict
      ? `COMPARISON_OK llm ${llmPass}/${results.length} vs det ${detPass}/${results.length}`
      : `COMPARISON_FAIL llm ${llmPass}/${results.length} vs det ${detPass}/${results.length}`,
  );
}

function assertParity(constraint: ReturnType<typeof toConstraint> & { slug: string }, s: string) {
  const body = `${s} ${CANONICAL_URL}`;
  const candidate = {
    body,
    threadParts: [] as string[],
    media: [] as CandidateMedia[],
    title: constraint.maxTitleChars === null ? null : "ok title",
    canonicalUrl: CANONICAL_URL,
  };
  const report = validateVariant(candidate, constraint);
  const lenCheck = report.checks.find((c) => c.id === "length.part.0");
  if (!lenCheck) throw new Error(`${constraint.slug}: no length.part.0 check`);
  const counted = countEffective(constraint.countMethod, body, constraint.urlCountsAsChars);
  if (lenCheck.ok !== counted <= constraint.maxChars) {
    throw new Error(
      `${constraint.slug}: parity mismatch — counted=${counted} max=${constraint.maxChars} check.ok=${lenCheck.ok}`,
    );
  }
}

async function parity() {
  const constraints = await loadConstraints();
  if (constraints.size === 0) throw new Error("no platform rows");
  // deterministic sweep: edge strings × every seeded platform
  const edgeStrings = [
    "",
    "x",
    "🔥🔥🔥 multi-grapheme 👨‍👩‍👧‍👦 family",
    "a".repeat(500),
    "hashtags #musebook #launch and a link",
    "emoji burst 🎉🎊✨🚀💡 with text",
    CANONICAL_URL,
    "のテキストとのミックス 😀",
  ];
  for (const [, c] of constraints) for (const s of edgeStrings) assertParity(c, s);
  console.log(`PARITY_OK ${constraints.size} platforms × ${edgeStrings.length} strings`);
}

async function ports() {
  const constraints = await loadConstraints();
  if (constraints.size === 0) throw new Error("no platform rows");
  const failures: string[] = [];
  for (const [slug, c] of constraints) {
    const media: CandidateMedia[] =
      c.minMedia > 0
        ? c.maxVideos > 0 && c.mediaRules.must_be_mp4 === true
          ? [VID]
          : [img(0)]
        : [];
    const cand = deterministicVariant(
      { plainBody: LONG_BODY, canonicalUrl: CANONICAL_URL, media },
      c,
    );
    const total = [cand.body, ...cand.threadParts].join("");
    if (total.length <= CANONICAL_URL.length + 40)
      failures.push(`${slug}: body is a stub (${total.length} chars)`);
    const report = validateVariant(cand, c);
    if (!report.ok) failures.push(`${slug}: ${report.failures.join("; ")}`);
  }
  if (failures.length) {
    console.log(`PORTS_FAIL ${failures.join(" | ")}`);
    return;
  }
  console.log(`PORTS_OK ${constraints.size} platforms, all full ports`);
}

async function release() {
  const db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    // A seeded active delegation takes the hold an agent-draft would leave.
    const delegationId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
    const {
      rows: [resv],
    } = await db.query<{ reservation_id: string }>(
      `select r.reservation_id::text
         from public.reserve_agent_spend($1::uuid, 100, 'distribution.publish', 'gate-m17') r`,
      [delegationId],
    );
    if (!resv?.reservation_id) throw new Error("reserve_agent_spend returned no reservation");
    const {
      rows: [rel],
    } = await db.query<{ released: boolean }>(
      `select public.release_agent_spend($1::uuid, 'gate-m17-fallback') as released`,
      [resv.reservation_id],
    );
    if (rel?.released !== true) throw new Error("release_agent_spend did not release the hold");
    const {
      rows: [row],
    } = await db.query<{ held: number }>(
      `select count(*)::int as held from public.agent_spend_reservations
        where id = $1::uuid and state = 'held'`,
      [resv.reservation_id],
    );
    await db.query(`delete from public.agent_spend_reservations where id = $1::uuid`, [
      resv.reservation_id,
    ]);
    if (row.held !== 0) throw new Error("reservation still held after release");
    console.log("RELEASE_OK reservation returned");
  } finally {
    await db.end();
  }
}

const sub = process.argv[2] ?? "comparison";
const fn = { comparison, parity, ports, release }[sub];
if (!fn) {
  console.error(`unknown subcommand ${sub}`);
  process.exit(2);
}
fn().catch((e) => {
  console.error(e);
  console.log(`${sub.toUpperCase()}_FAIL ${String(e).slice(0, 300)}`);
});
