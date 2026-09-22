// apps/edge/src/db/assets.ts — the media read path's asset lookup.
// assets is owner-scoped RLS; lookup_asset_by_key is the one security-definer
// helper that crosses it for the read path (D39). Runs on FRESH — the serve
// decision must never sit behind the cache.
import type { DbClient } from "./client.js";

export interface AssetRef {
  assetId: string;
  postId: string;
  storage: "r2_public" | "r2_paid" | "r2_artifacts";
}

export async function lookupAsset(db: DbClient, objectKey: string): Promise<AssetRef | null> {
  const { rows } = await db.query<{
    asset_id: string;
    post_id: string;
    storage: AssetRef["storage"];
  }>("select * from app.lookup_asset_by_key($1)", [objectKey]);
  const r = rows[0];
  if (r === undefined) return null;
  return { assetId: r.asset_id, postId: r.post_id, storage: r.storage };
}
