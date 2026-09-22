import type { Resource } from "@musebook/schema";

export const ORIGIN = "https://musebook.dev";

export const MARKDOWN = `# Ship the ledger

Intro paragraph with **bold** and a [link](https://example.com/x).

- first
- second
  - nested a
  - nested b
- third

\`\`\`ts
const x: number = 1;
\`\`\`

> a quote
> on two lines

1. one
2. two

Final line.
`;

export const fixture: Resource = {
  postId: "019aa0e3-0000-7000-8000-000000000001",
  authorUserId: "019aa0e3-0000-7000-8000-000000000002",
  authorDisplayName: "Ada Maker",
  authorHandle: "ada",
  authorWallet: "0x000000000000000000000000000000000000beef",
  kind: "article",
  status: "published",
  publishMode: "human_free_agent_paid",
  slug: "ship-the-ledger",
  title: "Ship the ledger",
  summary: "How the paid-read ledger lands at the edge.",
  canonicalUrl: "https://musebook.dev/p/ship-the-ledger",
  languageCode: "en",
  tags: ["edge", "ledger"],
  contentHash: "",
  canonicalMarkdown: MARKDOWN,
  priceAtomic: "420",
  priceUsd: "4.20",
  priceAsset: "USDC",
  priceNetwork: "eip155:8453",
  revenueShareVersion: "rs_v1",
  licenseSpdx: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  trainAi: true,
  aiUse: true,
  searchIndexable: true,
  attributionRequired: true,
  citationTemplate: "{author}, {title}, {url}",
  publishedAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-21T08:30:00.000Z",
};
