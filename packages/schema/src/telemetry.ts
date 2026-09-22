// packages/schema/src/telemetry.ts
import { z } from "zod";
import { evidenceKind, type EvidenceKind } from "./actor.js";
import { agentSurfaceSchema, humanSurfaceSchema } from "./surface.js";

/** Actions the browser collector is allowed to report. All five are values of
 *  section 4.2's `action_kind`, which is the full Musebook set from day one;
 *  this file adds no vocabulary of its own. Engagement actions (like, comment,
 *  repost, bookmark, share, follow, remix, fork_app, install_app, tip) and the
 *  negative heads (not_interested, mute_creator, block_creator, report) are
 *  NOT here: those are written server-side by the mutation route that performs
 *  them. A client may never assert an engagement it did not cause.
 *  `not_dwelled` is never an event at all: section 9's label builder derives it
 *  from an `impression` with no `dwell` row in the same `view_session_id`. */
export const CLIENT_REPORTABLE_ACTIONS = [
  "impression",
  "view",
  "dwell",
  "play",
  "play_through",
] as const;

export const clientActionSchema = z.enum(CLIENT_REPORTABLE_ACTIONS);
export type ClientAction = z.infer<typeof clientActionSchema>;

const uuid = z.uuid();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const mediaDetailSchema = z.object({
  asset_id: uuid,
  watched_ms: z.number().int().min(0).max(14_400_000).optional(),
  duration_ms: z.number().int().min(0).max(14_400_000).optional(),
  /** 0 on the first `play` of an asset in this view session, 1..3 on replays. */
  play_index: z.number().int().min(0).max(50).optional(),
  muted: z.boolean().optional(),
});
export type MediaDetail = z.infer<typeof mediaDetailSchema>;

export const humanEventSchema = z.object({
  /** Client-generated; the server's idempotency key together with occurred_at. */
  event_id: uuid,
  /** Client epoch ms. Clamped server-side; never stored raw. */
  t: z.number().int().min(1_600_000_000_000).max(4_100_000_000_000),
  action: clientActionSchema,
  post_id: uuid,
  content_hash: sha256Hex,
  surface: humanSurfaceSchema,
  /** SPINE INVARIANT 3. Echoed back from the slate the item was served in.
   *  weights_version / model_version are NOT accepted from the client — the
   *  server resolves them from public.slates (§13.4.4). */
  slate_id: uuid,
  position: z.number().int().min(0).max(10_000),
  /** One per page view, minted by the client. Never leaves the human plane,
   *  and never reaches Analytics Engine at all (§13.3.1). */
  view_session_id: uuid,
  dwell_ms: z.number().int().min(0).max(3_600_000).optional(),
  max_scroll_pct: z.number().int().min(0).max(100).optional(),
  /** Media only. On the terminal `dwell` row of a media post: the furthest
   *  quartile reached (0/25/50/75, or 100 once played through). On a
   *  `play_through` row: 85..100 (section 9's definition of the head). */
  completion_pct: z.number().int().min(0).max(100).optional(),
  media: mediaDetailSchema.optional(),
  viewport: z
    .object({
      w: z.number().int().min(0).max(16_384),
      h: z.number().int().min(0).max(16_384),
      dpr: z.number().min(0.5).max(8),
    })
    .optional(),
});
export type HumanEvent = z.infer<typeof humanEventSchema>;

export const humanBatchSchema = z.object({
  v: z.literal(1),
  sent_at: z.number().int(),
  events: z.array(humanEventSchema).min(1).max(16),
});
export type HumanBatch = z.infer<typeof humanBatchSchema>;

/** How confident Musebook is that the caller is the agent it says it is. This
 *  is NOT a second evidence vocabulary: it is `evidenceKind` from
 *  packages/schema/src/actor.ts (section 5.6), and the value written on an
 *  agent row is the most reliable kind present in `actor.evidence[]`. */
export function strongestEvidence(evidence: readonly { kind: EvidenceKind }[]): EvidenceKind {
  const order = evidenceKind.options; // declared most -> least reliable
  let best = order.length - 1; // 'none'
  for (const e of evidence) best = Math.min(best, order.indexOf(e.kind));
  return order[best] ?? "none";
}

/** The subset of section 4.2's `action_kind` that the agent-plane writers
 *  produce. Section 7.9's table maps every tool outcome onto exactly these,
 *  and onto exactly one store. */
export const agentActionSchema = z.enum([
  "impression",
  "agent_crawl",
  "x402_pay",
  "follow",
  "agent_cite",
]);

/** Constructed server-side only, from the one `Actor` (section 5.6). Validated
 *  before it is written — to either store — so a bug in a tool handler fails in
 *  the telemetry writer, not two weeks later in a rollup. */
export const agentEventSchema = z.object({
  event_id: uuid,
  occurred_at: z.iso.datetime({ offset: true }),
  action: agentActionSchema,
  /** actor.agentIdentityId — never null here; section 7.9 step 4 guarantees a row. */
  actor_agent_id: uuid,
  /** actor.directoryKeyid, verbatim. */
  agent_key_thumbprint: z.string().min(16).max(128).nullable(),
  /** strongestEvidence(actor.evidence). */
  evidence: evidenceKind,
  /** actor.declaredIntent — declared, never observed (section 6.14). */
  declared_intent: z.enum(["read", "crawl", "train", "unknown"]),
  post_id: uuid.nullable(),
  content_hash: sha256Hex.nullable(),
  surface: agentSurfaceSchema,
  mcp_tool: z.string().max(64).nullable(),
  slate_id: uuid,
  position: z.number().int().min(0),
  outcome: z.enum(["ok", "payment_required", "input_required", "denied", "error", "partial"]),
  bytes_served: z.number().int().min(0).nullable(),
  settlement_id: uuid.nullable(),
  amount_atomic: z.string().regex(/^\d+$/).nullable(),
  passages: z
    .array(
      z.object({
        start: z.number().int().min(0),
        end: z.number().int().min(0),
        heading: z.string().max(200).optional(),
      }),
    )
    .max(64)
    .optional(),
  request_id: z.string().max(64).nullable(),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;
