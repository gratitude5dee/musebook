// apps/web/app/(marketing)/_islands/demo-fixtures.ts — §14.3 S1, rule 2: the
// fallback set when the network has fewer than nine open posts. Every card is
// a sample, authored by the project, marked isSample so the panel renders the
// notice verbatim rather than pretending to be the live top nine.
import type { DemoPost, InterestKey } from "./rerank-types";

const f = (p: Partial<Record<InterestKey, number>>): Record<InterestKey, number> => ({
  genvideo: 0,
  artifacts3d: 0,
  agenttooling: 0,
  longform: 0,
  designsystems: 0,
  payments: 0,
  music: 0,
  research: 0,
  shitposts: 0,
  launches: 0,
  ...p,
});

const P = "/demo/muse-poster.svg";

export const DEMO_FIXTURES: DemoPost[] = [
  {
    id: "fx-1",
    kind: "article",
    title: "The 402 handshake, end to end",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ payments: 0.9, agenttooling: 0.6, research: 0.4, longform: 0.7 }),
    isSample: true,
  },
  {
    id: "fx-2",
    kind: "model3d",
    title: "A low-poly muse, rendered in the feed",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ artifacts3d: 0.95, designsystems: 0.4, genvideo: 0.3 }),
    isSample: true,
  },
  {
    id: "fx-3",
    kind: "video",
    title: "Sixty seconds of a latent walk",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ genvideo: 0.95, music: 0.3, launches: 0.2 }),
    isSample: true,
  },
  {
    id: "fx-4",
    kind: "app",
    title: "Draft, sign, settle — a 90-line MCP client",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ agenttooling: 0.95, payments: 0.5, launches: 0.4 }),
    isSample: true,
  },
  {
    id: "fx-5",
    kind: "article",
    title: "Why every served item carries a slate_id",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ research: 0.9, longform: 0.8, agenttooling: 0.3 }),
    isSample: true,
  },
  {
    id: "fx-6",
    kind: "image",
    title: "A token system in one sheet",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ designsystems: 0.9, longform: 0.3 }),
    isSample: true,
  },
  {
    id: "fx-7",
    kind: "audio",
    title: "A two-minute loop, CC0",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ music: 0.95, shitposts: 0.2 }),
    isSample: true,
  },
  {
    id: "fx-8",
    kind: "thread",
    title: "Shipping a connector registry in a weekend",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ agenttooling: 0.7, launches: 0.8, shitposts: 0.4 }),
    isSample: true,
  },
  {
    id: "fx-9",
    kind: "note",
    title: "unpopular: a feed should show its work",
    authorHandle: "musebook",
    posterUrl: P,
    features: f({ shitposts: 0.85, longform: 0.5, research: 0.3 }),
    isSample: true,
  },
];

export const INTEREST_CHIPS: Array<{ key: InterestKey; label: string }> = [
  { key: "genvideo", label: "generative video" },
  { key: "artifacts3d", label: "3D artifacts" },
  { key: "agenttooling", label: "agent tooling" },
  { key: "longform", label: "longform essays" },
  { key: "designsystems", label: "design systems" },
  { key: "payments", label: "onchain payments" },
  { key: "music", label: "music" },
  { key: "research", label: "research papers" },
  { key: "shitposts", label: "shitposts" },
  { key: "launches", label: "product launches" },
];
