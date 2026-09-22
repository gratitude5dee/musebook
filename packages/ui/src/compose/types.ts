// packages/ui/src/compose/types.ts — the composer's transport contract.
// Nothing in this package fetches: apps/web injects the three verbs (draft
// save over PostgREST, publish through musebook-edge, media upload through
// the signing route) so the composer itself stays platform-agnostic.
import type { PostKind } from "@musebook/schema";

/** §6.3's picker vocabulary — the composer never names the column it maps to. */
export type AccessChoice = "open" | "toll" | "gated";

/** Everything a draft save carries. `priceUsd` stays a decimal STRING end to
 *  end — an implicit Number() on the money path is a rounding bug (§14.4.5). */
export interface DraftInput {
  postId: string | null;
  kind: PostKind;
  markdown: string;
  title: string | null;
  summary: string | null;
  access: AccessChoice;
  priceUsd: string | null;
  licenseSpdx: string;
  trainAi: boolean;
  aiUse: boolean;
  searchIndexable: boolean;
  tags: string[];
}

export interface SavedDraft {
  postId: string;
  slug: string;
  version: number;
  contentHash: string;
}

export interface ComposerActions {
  saveDraft(input: DraftInput): Promise<SavedDraft>;
  /** POST /api/posts/{id}/publish on the edge — the browser hits the Worker,
   *  which resolves the mb_session cookie to the human_creator actor. */
  publish(postId: string, platforms: string[]): Promise<void>;
  /** init → PUT parts → complete against /api/uploads/*, returning the
   *  promoted markdown to splice into the draft (a `staging/` key; promotion
   *  is the r2-events consumer's job, §11.7.3). */
  uploadMedia(
    file: File,
    postId: string | null,
    opts: { storage: "r2_public" | "r2_paid" },
  ): Promise<{ markdown: string }>;
}

export interface ComposerInitial extends DraftInput {
  slug: string | null;
  contentHash: string | null;
  status: string | null;
  /** §1.4's edit-after-grant warning count: access_grants on the post or on
   *  any of its versions' content hashes. 0 → the warning never arms. */
  liveGrantCount: number;
}
