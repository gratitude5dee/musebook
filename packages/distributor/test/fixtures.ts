// test/fixtures.ts — the 26 golden candidates + 13 constraints, imported as
// JSON through Vite so BOTH the node and workerd tiers run the same fixtures.
import type { PlatformConstraint } from "../src/constraints";
import type { VariantCandidate } from "../src/validate";

import xC from "./fixtures/x.constraint.json";
import linkedinC from "./fixtures/linkedin.constraint.json";
import instagramC from "./fixtures/instagram.constraint.json";
import tiktokC from "./fixtures/tiktok.constraint.json";
import youtubeC from "./fixtures/youtube.constraint.json";
import threadsC from "./fixtures/threads.constraint.json";
import blueskyC from "./fixtures/bluesky.constraint.json";
import mastodonC from "./fixtures/mastodon.constraint.json";
import redditC from "./fixtures/reddit.constraint.json";
import farcasterC from "./fixtures/farcaster.constraint.json";
import discordC from "./fixtures/discord.constraint.json";
import telegramC from "./fixtures/telegram.constraint.json";
import pinterestC from "./fixtures/pinterest.constraint.json";

import xOk from "./fixtures/x.ok.json";
import linkedinOk from "./fixtures/linkedin.ok.json";
import instagramOk from "./fixtures/instagram.ok.json";
import tiktokOk from "./fixtures/tiktok.ok.json";
import youtubeOk from "./fixtures/youtube.ok.json";
import threadsOk from "./fixtures/threads.ok.json";
import blueskyOk from "./fixtures/bluesky.ok.json";
import mastodonOk from "./fixtures/mastodon.ok.json";
import redditOk from "./fixtures/reddit.ok.json";
import farcasterOk from "./fixtures/farcaster.ok.json";
import discordOk from "./fixtures/discord.ok.json";
import telegramOk from "./fixtures/telegram.ok.json";
import pinterestOk from "./fixtures/pinterest.ok.json";

import xBad from "./fixtures/x.bad.json";
import linkedinBad from "./fixtures/linkedin.bad.json";
import instagramBad from "./fixtures/instagram.bad.json";
import tiktokBad from "./fixtures/tiktok.bad.json";
import youtubeBad from "./fixtures/youtube.bad.json";
import threadsBad from "./fixtures/threads.bad.json";
import blueskyBad from "./fixtures/bluesky.bad.json";
import mastodonBad from "./fixtures/mastodon.bad.json";
import redditBad from "./fixtures/reddit.bad.json";
import farcasterBad from "./fixtures/farcaster.bad.json";
import discordBad from "./fixtures/discord.bad.json";
import telegramBad from "./fixtures/telegram.bad.json";
import pinterestBad from "./fixtures/pinterest.bad.json";

export interface FixtureSet {
  readonly constraint: PlatformConstraint;
  readonly ok: VariantCandidate;
  readonly bad: VariantCandidate;
  /** check ids expected to fail on the bad candidate (error severity). */
  readonly badChecks: readonly string[];
}

export const FIXTURES: Readonly<Record<string, FixtureSet>> = {
  x: {
    constraint: xC as PlatformConstraint,
    ok: xOk as VariantCandidate,
    bad: xBad as VariantCandidate,
    badChecks: ["length.part.0", "media.mixed"],
  },
  linkedin: {
    constraint: linkedinC as PlatformConstraint,
    ok: linkedinOk as VariantCandidate,
    bad: linkedinBad as VariantCandidate,
    badChecks: ["thread.unsupported"],
  },
  instagram: {
    constraint: instagramC as PlatformConstraint,
    ok: instagramOk as VariantCandidate,
    bad: instagramBad as VariantCandidate,
    badChecks: ["media.min"],
  },
  tiktok: {
    constraint: tiktokC as PlatformConstraint,
    ok: tiktokOk as VariantCandidate,
    bad: tiktokBad as VariantCandidate,
    badChecks: ["title.length"],
  },
  youtube: {
    constraint: youtubeC as PlatformConstraint,
    ok: youtubeOk as VariantCandidate,
    bad: youtubeBad as VariantCandidate,
    badChecks: ["media.images"],
  },
  threads: {
    constraint: threadsC as PlatformConstraint,
    ok: threadsOk as VariantCandidate,
    bad: threadsBad as VariantCandidate,
    badChecks: ["thread.too_many"],
  },
  bluesky: {
    constraint: blueskyC as PlatformConstraint,
    ok: blueskyOk as VariantCandidate,
    bad: blueskyBad as VariantCandidate,
    badChecks: ["media.mixed"],
  },
  mastodon: {
    constraint: mastodonC as PlatformConstraint,
    ok: mastodonOk as VariantCandidate,
    bad: mastodonBad as VariantCandidate,
    badChecks: ["length.part.0"],
  },
  reddit: {
    constraint: redditC as PlatformConstraint,
    ok: redditOk as VariantCandidate,
    bad: redditBad as VariantCandidate,
    badChecks: ["title.length"],
  },
  farcaster: {
    constraint: farcasterC as PlatformConstraint,
    ok: farcasterOk as VariantCandidate,
    bad: farcasterBad as VariantCandidate,
    badChecks: ["media.videos", "media.images_only"],
  },
  discord: {
    constraint: discordC as PlatformConstraint,
    ok: discordOk as VariantCandidate,
    bad: discordBad as VariantCandidate,
    badChecks: ["length.part.0"],
  },
  telegram: {
    constraint: telegramC as PlatformConstraint,
    ok: telegramOk as VariantCandidate,
    bad: telegramBad as VariantCandidate,
    badChecks: ["editor.html"],
  },
  pinterest: {
    constraint: pinterestC as PlatformConstraint,
    ok: pinterestOk as VariantCandidate,
    bad: pinterestBad as VariantCandidate,
    badChecks: ["media.identical_dims"],
  },
};

export const PLATFORM_SLUGS = Object.keys(FIXTURES);
