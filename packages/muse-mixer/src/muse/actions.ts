// packages/muse-mixer/src/muse/actions.ts
export const MUSE_ACTIONS = [
  "impression", //  0  card ≥50 % visible for ≥1 s (§13.4); the exposure denominator, weight 0
  "view", //  1  the post was opened / entered the viewport as a read
  "dwell", //  2  discrete: dwell >= DwellThresholdMs
  "play", //  3  media playback began
  "play_through", //  4  >= 85% of media consumed
  "like", //  5
  "comment", //  6
  "repost", //  7
  "bookmark", //  8  bookmark / add to collection
  "share", //  9  shared to an external platform (the Postiz hop), by a READER
  "follow", // 10  followed the creator from this post
  "remix", // 11  created a derivative post
  "fork_app", // 12  forked an app/artifact into own workspace
  "install_app", // 13  installed an app / added its MCP tool
  "tip", // 14  a voluntary x402 tip attached to this post
  "x402_pay", // 15  a settled x402 purchase of this post's bytes
  "agent_crawl", // 16  an agent paid-crawled or MCP-fetched this post
  "agent_cite", // 17  an agent self-declared a citation (§7.17)
  "not_interested", // 18  NEGATIVE
  "mute_creator", // 19  NEGATIVE
  "block_creator", // 20  NEGATIVE
  "report", // 21  NEGATIVE
  "not_dwelled", // 22  NEGATIVE — on reels this is the skip signal
] as const;
export type MuseAction = (typeof MUSE_ACTIONS)[number];

export const MUSE_NEGATIVE_ACTIONS = [
  "not_interested",
  "mute_creator",
  "block_creator",
  "report",
  "not_dwelled",
] as const satisfies readonly MuseAction[];

export const MUSE_CONTINUOUS = [
  "dwell_time_s",
  "watch_time_ms",
  "scroll_depth",
  "active_seconds_5m",
  "tip_amount_usdc",
] as const;
export type MuseContinuous = (typeof MUSE_CONTINUOUS)[number];
