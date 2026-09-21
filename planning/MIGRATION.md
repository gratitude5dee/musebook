# MIGRATION ADDENDUM — binding, applies to sections 1, 3, 4, 15, 16, 18

**OWNER DECISION, 2026-09-21: migrate ZERO users. Musebook launches with an empty database.**

The owner first asked for a new Supabase project with everything migrated into it, then — once the
measured contents below were known — ruled that no users are migrated. Because every content row in
the legacy project is keyed to a user id, that ruling makes the rest of the migration moot: there is
no owner to attach 8 posts, 15 tracks or 12 video records to.

So §1's non-goal "any data migration off `ixkkrousepsiorwlaycp`" STANDS, but its justification
changes from "out of scope for v1" to "there is nothing worth moving, and the user identities that
would anchor it are deliberately not coming across." Say that, with the numbers, so nobody
re-opens it in three months believing data was abandoned by oversight.

## What is actually there — measured on the live project, 2026-09-21

| Table | Rows | Assessment |
|---|---|---|
| `mog_posts` | 8 | 5 point at storage keys with no backing object; 2 at `picsum.photos` placeholders |
| `mog_likes` / `mog_comments` / `mog_bookmarks` / `mog_follows` | 3 / 1 / 2 / 0 | real but trivial |
| `mog_agent_profiles` | 1 | real |
| `music_tracks` | 15 | **zero rows have a non-null `audio_path`** — no audio exists |
| `music_videos` | 12 | all `video_path` are storage keys; the `mog-media` bucket holds **0 objects** |
| `music_albums` | 5 | metadata only |
| `music_streams` / `music_transactions` | 21 / 21 | **fabricated** — random-hex `tx_hash`, `status:'confirmed'` |
| `music_video_streams` / `music_video_transactions` | 22 / 22 | **fabricated**, same defect |
| `engagement_payouts` / `creator_balances` / `user_karma` / `token_config` | 10 / 7 / 3 / 5 | derived from the fabricated rows |
| `articles` | 21 | **not Musebook's** — columns `source_id`, `canonical_url`, `fetched_at`, `simhash` are the news crawler's; 0 are mog-branded |
| `auth.users` | 36 | shared across every app in the project, not Mog-specific |
| `storage` | 20 buckets, 540 objects, 811 MB | `mog-media` has **0 objects**; the 540 are `workflow-media` (507), `project-assets` (23), `wzrd-studio-*` (4), `videos-input` (3), `audio` (2), others (1) — all other products' |

Eight tables the repo's migrations create do not exist in the live database at all
(`moltbook_profiles`, `videos`, `video_streams`, `video_transactions`, `play_events`, `track_events`,
`stream_sessions`, `entitlements`), which is consistent with §4.17's finding that the chain is unreplayable.

## The ruling: migrate NOTHING. There is no ETL.

**Zero users. Zero content. Zero media. Musebook's database starts empty and is populated by real
use.** The legacy project is a read-only historical reference and nothing more.

The reasoning, in the order it actually matters:

1. **No users, by owner decision.** All 36 `auth.users` are shared across a dozen unrelated apps in
   that project; none come across. Identity is re-established on first sign-in through thirdweb,
   which keys on wallet anyway — so a migrated row would have been redundant the moment its owner
   logged in.
2. **Content cannot outlive its authors.** `mog_posts`, `mog_likes`, `mog_comments`,
   `mog_bookmarks`, `mog_follows` and `mog_agent_profiles` are all keyed to user ids. With no users
   there is no author to attach them to. The alternative — import them under a placeholder identity
   with a wallet-based "claim your content" flow — is real work (a claimable state, a claim surface
   in §14, a reconciliation path) and it would be built for **6 posts, 5 of which have broken media
   pointers**. That is indefensible. If those 6 posts are wanted, re-creating them by hand takes
   minutes and produces cleaner rows than any importer would.
3. **There is no media to move regardless.** `mog-media` holds 0 objects, no `music_track` has a
   non-null `audio_path`, and all 12 `music_videos` reference storage keys with no backing object.
   A media migration would copy nothing and resolve nothing.
4. **Some of it is actively harmful.** `music_streams`, `music_transactions`,
   `music_video_streams`, `music_video_transactions`, `engagement_payouts`, `creator_balances`,
   `user_karma` and `token_config` — 86 rows — carry random-hex `tx_hash` values written with
   `status:'confirmed'`. Had any migration been built, importing these would have seeded the new
   `payout_ledger` and `x402_settlements` with transactions that never happened and can never be
   reconciled against Base. §15 flags the originating defect; this is why it also never crosses a
   database boundary.
5. **`articles` was never ours.** Its columns (`source_id`, `canonical_url`, `fetched_at`,
   `simhash`) are the news crawler's, and zero of its 21 rows are mog-branded.

**The one hard rule that survives:** no Musebook runtime code, migration, seed, test fixture or CI
job may hold a connection to `ixkkrousepsiorwlaycp`. Enforced by the existing `legacy-ref` CI grep.

## Where this lands in the plan
- **§1** — KEEP the non-goal, but replace its justification with the measured findings above
  (~35 content rows, 0 media objects, 86 fabricated money rows, 0 users by decision). No migration
  line appears anywhere in the MVP cut line.
- **§3.12** — **DELETE the one-time ETL script entirely.** It is no longer a deliverable. Replace
  the subsection with a short "Legacy data: none is migrated, and why" note carrying the table above,
  plus the standing `legacy-ref` CI rule.
- **§4** — **DROP `legacy_source` and `legacy_id`** from the `posts` DDL and anywhere else they were
  added; nothing is imported, so nothing needs legacy traceability. Also drop the `needs_media`
  status if it exists solely to serve migrated records — confirm it has no other caller first.
- **§16** — **DELETE the migration milestone.** Nothing depends on it. The seed data for development
  and tests comes entirely from §17.3.2's deterministic seed script (5 users, 24 posts), which is
  synthetic and already specified.
- **§17** — unchanged: the seed fixture was already synthetic, so it needs no migrated data.
- **§18** — the `auth.users` question is CLOSED, recorded as a decision with its consequence
  (Musebook launches empty; the 6 real legacy posts can be re-created by hand if wanted).
- **§15** — keep the MogBook remediation items. They describe defects in a live system the owner
  still runs; they are independent of whether Musebook imports from it.
