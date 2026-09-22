// apps/worker/src/consumers/r2-events.ts — §11.7.3's promotion consumer.
// musebook-r2-events carries R2's OWN object-create shape, not a job_outbox
// row, so it bypasses the claim→work→finish skeleton: the staged_uploads row
// is the claim and its delete is the idempotency boundary.
import { assetKey, assetUrl, uploadExt, type AssetStorage } from "@musebook/media";
import { pgFresh } from "../db.js";

/** R2's object-create event shape (fields we read). */
interface R2Event {
  account?: string;
  action?: string;
  bucket?: string;
  object?: { key?: string; size?: number; eTag?: string; contentType?: string };
  eventTime?: string;
}

async function sha256Of(body: ReadableStream): Promise<string> {
  const digest = new crypto.DigestStream("SHA-256");
  await body.pipeTo(digest);
  const sum = await digest.digest;
  return [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One object-create event → promote to musebook-public/-paid by the post's
 *  resolved tier, write the assets row, link post_assets, delete the staged
 *  object. A staged_uploads row missing means a redelivery or a foreign object —
 *  ack without work (the delete already ran). */
export async function handleR2ObjectCreated(env: Env, event: R2Event): Promise<void> {
  const key = event.object?.key;
  if (
    event.action !== "PutObject" ||
    event.bucket !== "musebook-uploads" ||
    typeof key !== "string" ||
    !key.startsWith("staging/")
  ) {
    return;
  }

  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{
      post_id: string | null;
      uploader_user_id: string;
      content_type: string;
      byte_len: number | string;
      target_storage: AssetStorage;
    }>("select * from app.staged_upload_target($1)", [key]);
    const staged = rows[0];
    if (staged === undefined) return; // consumed, or an object we never staged

    // Hash before the copy: the destination key is content-addressed
    // (m/{sha}.{ext} / p/{sha}.{ext}, §11.7.2).
    const src = await env.UPLOADS.get(key);
    if (src === null) throw new Error(`staged object vanished: ${key}`);
    const sha256 = await sha256Of(src.body);

    const filename = key.slice(key.lastIndexOf("/") + 1);
    const ext = uploadExt(filename, staged.content_type);
    const storage = staged.target_storage;
    const destKey = assetKey(storage, sha256, ext);
    const url = assetUrl(storage, destKey);
    const dest = storage === "r2_paid" ? env.PAID_MEDIA : env.PUBLIC_MEDIA;

    // put-before-delete: no window where the object lives in neither bucket.
    const again = await env.UPLOADS.get(key);
    if (again === null) throw new Error(`staged object vanished: ${key}`);
    await dest.put(destKey, again.body, {
      httpMetadata: { contentType: staged.content_type },
    });

    const { rows: recorded } = await db.query<{ record_uploaded_asset: string | null }>(
      "select app.record_uploaded_asset($1,$2,$3,$4,$5,$6::bigint,$7)",
      [key, storage, destKey, url, staged.content_type, again.size, sha256],
    );
    if (recorded[0]?.record_uploaded_asset == null) {
      throw new Error(`assets row not recorded for ${key}`);
    }

    await env.UPLOADS.delete(key);
  } finally {
    await db.end();
  }
}
