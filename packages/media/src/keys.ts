// packages/media/src/keys.ts — §11.7.2's key conventions, the only place these
// strings are built. Keys are content-addressed, never post-addressed: an
// assets_sha_owner_uniq dedupe plus a sha256 key means a post edit can never
// re-key an object, and Cache-Control: immutable stays honest.
//
// `storage` is the assets.storage vocabulary — 'r2_public' | 'r2_paid' |
// 'r2_artifacts'. the access vocabulary never reaches this file (§6.3).

export type AssetStorage = "r2_public" | "r2_paid" | "r2_artifacts";

const CDN_ORIGIN = "https://cdn.musebook.dev";
const MEDIA_ORIGIN = "https://media.musebook.dev";
const ARTIFACT_ORIGIN_URL = "https://artifacts.musebook.dev";

const EXT_OK = /^[a-z0-9]{1,8}$/;

/** `m/{sha}.{ext}` for public, `p/{sha}.{ext}` for paid — §11.7.2's table. */
export function assetKey(storage: AssetStorage, sha256: string, ext: string): string {
  const normalized = ext.toLowerCase();
  if (!EXT_OK.test(normalized)) throw new Error(`bad asset extension: ${ext}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be 64 hex chars");
  const prefix = storage === "r2_paid" ? "p" : storage === "r2_public" ? "m" : "a";
  return `${prefix}/${sha256}.${normalized}`;
}

/** The serving URL for a key — the pairing the assets_url_matches_bucket
 *  CHECK enforces (§4.4). */
export function assetUrl(storage: AssetStorage, key: string): string {
  const origin =
    storage === "r2_public"
      ? CDN_ORIGIN
      : storage === "r2_paid"
        ? MEDIA_ORIGIN
        : ARTIFACT_ORIGIN_URL;
  return `${origin}/${key}`;
}

/** Extension derivation for uploads: last dot-suffix of the filename, else
 *  from the content-type's subtype; 'bin' when neither parses. */
export function uploadExt(filename: string, contentType: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot + 1).toLowerCase();
    if (EXT_OK.test(ext)) return ext;
  }
  const sub = contentType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  return sub !== undefined && EXT_OK.test(sub) ? sub : "bin";
}

/** `pay` for posts with a price, `free` otherwise — the tier divider the
 *  finalize consumer applies when choosing the object bucket. */
export type MediaTier = "free" | "paid";

export function storageFor(tier: MediaTier): AssetStorage {
  return tier === "paid" ? "r2_paid" : "r2_public";
}

/** Generated-asset key: same content-addressed convention as uploads —
 *  `m/{sha}.{ext}` free / `p/{sha}.{ext}` paid. `ext` comes from the
 *  provider's returned content-type, never the request. */
export function objectKey(tier: MediaTier, sha256: string, contentType: string): string {
  const ext = uploadExt("", contentType);
  return assetKey(storageFor(tier), sha256, ext);
}

/** `{object_key}.c2pa` — same bucket as the asset, always (§11.7.2). */
export function sidecarKey(key: string): string {
  return `${key}.c2pa`;
}

/** `t/{sha}/{width}.webp` — generated thumbnails. */
export function thumbnailKey(sha256: string, width: number): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be 64 hex chars");
  if (!Number.isInteger(width) || width <= 0) throw new Error("width must be a positive int");
  return `t/${sha256}/${width}.webp`;
}

/** `staging/{userId}/{uuid}/{filename}` — presigned upload staging in
 *  musebook-uploads. Sanitized: filename reduced to its basename. */
export function stagingKey(userId: string, fileId: string, filename: string): string {
  const base = filename.split("/").pop()?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? "file";
  return `staging/${userId}/${fileId}/${base}`;
}
