// packages/distributor/src/analytics/normalize.ts — §12.3.10 verbatim.
export interface NormalizedMetrics {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  reposts: number;
  saves: number;
  clicks: number;
}

/** Postiz AnalyticsData[] labels -> Musebook columns. Labels are the provider's. */
const LABEL_MAP: Readonly<Record<string, keyof NormalizedMetrics>> = {
  // x.provider.ts
  IMPRESSIONS: "impressions",
  Impressions: "impressions",
  LIKES: "likes",
  Likes: "likes",
  Retweets: "reposts",
  Quotes: "reposts",
  Replies: "comments",
  Bookmarks: "saves",
  // youtube / tiktok
  Views: "impressions",
  Comments: "comments",
  Shares: "shares",
  "Recent Likes": "likes",
  "Recent Comments": "comments",
  "Recent Shares": "shares",
  Favorites: "saves",
  // pinterest
  "Pin Clicks": "clicks",
  "Outbound Clicks": "clicks",
  Saves: "saves",
};

export function normalize(
  series: readonly { label: string; data: readonly { total: string; date: string }[] }[],
): NormalizedMetrics {
  const out: NormalizedMetrics = {
    impressions: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    reposts: 0,
    saves: 0,
    clicks: 0,
  };
  for (const s of series) {
    const key = LABEL_MAP[s.label];
    if (key === undefined) continue; // unmapped labels go to `raw` only
    const last = s.data.at(-1);
    if (last === undefined) continue;
    const n = Number.parseInt(last.total, 10);
    if (Number.isFinite(n)) out[key] += n;
  }
  return out;
}
