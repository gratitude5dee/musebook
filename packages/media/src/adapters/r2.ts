// packages/media/src/adapters/r2.ts — the R2 write path (§11.7/§11.8).
// musebook-media-finalize streams provider bytes into the tier bucket
// (musebook-paid `p/…` or musebook-public `m/…`, content-addressed per
// keys.ts) plus the `.c2pa` sidecar. The bucket is only written HERE —
// the webhook route never touches storage.
export interface MediaBucketLike {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  head?(key: string): Promise<{ size: number } | null>;
}

/** Buffer the provider body once and hash it — the consumer needs the bytes
 *  in memory anyway for the safety gates and the provenance round-trip. */
export async function bufferAndHash(
  res: Response,
): Promise<{ bytes: Uint8Array; sha256: string; byteLength: number }> {
  const raw = new Uint8Array(await res.arrayBuffer());
  const sum = await crypto.subtle.digest("SHA-256", raw);
  const sha256 = [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { bytes: raw, sha256, byteLength: raw.byteLength };
}

export async function putBytes(
  bucket: MediaBucketLike,
  key: string,
  bytes: Uint8Array | ArrayBuffer,
  contentType: string,
): Promise<void> {
  await bucket.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { "x-musebook-generated": "true" },
  });
}

/** The retried-delivery rule: on 'already_final' delete what was just written. */
export async function deleteKey(bucket: MediaBucketLike, key: string): Promise<void> {
  await bucket.delete(key).catch(() => undefined);
}
