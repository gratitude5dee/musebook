// apps/worker/src/consumers/r2-events.ts — §11.7.3's promotion consumer.
// musebook-r2-events carries R2's OWN object-create shape, not a job_outbox
// row, so it bypasses the claim→work→finish skeleton: the staged_uploads row
// is the claim and its delete is the idempotency boundary.
import { assetKey, assetUrl, uploadExt, type AssetStorage } from "@musebook/media";
import { signInternalRequest } from "@musebook/schema/internal-signature";
import { pgFresh, pgFreshJobs } from "../db.js";

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
  if (key.endsWith("/bundle.tar.gz")) {
    await ingestArtifactBundle(env, key, event.object?.size ?? 0);
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

// ── §11.12 steps 3–5: the artifact ingest branch ──────────────────────────
// A staged bundle.tar.gz never becomes an assets row: the sandbox explodes it
// into per-file objects under a/{visibility}/{version}/ and one poster.

const ARTIFACT_INGEST_URL = "https://musebook.dev/api/internal/artifacts/ingest";
// artifacts.kind vocabulary (§4.4): glb carries 11.15's 12 MB cap; every 2D
// bundle shape carries 11.13's 5 MB cap.
const BUNDLE_CAPS: Record<string, number> = { glb: 12 * 1024 * 1024 };
const DEFAULT_BUNDLE_CAP = 5 * 1024 * 1024;

function toB64(u8: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

interface IngestFile {
  path: string;
  content_type: string;
  sha256: string;
  content_b64: string;
}
interface IngestReport {
  ok: boolean;
  rejection?: { code: string; message: string };
  version?: string;
  manifest?: Record<string, unknown>;
  entry_path?: string;
  files?: IngestFile[];
  poster?: { content_type: string; content_b64: string } | null;
  metrics?: {
    total_bytes: number;
    file_count: number;
    gzip_bytes: number;
    triangle_count: number | null;
    texture_bytes: number | null;
    draw_call_estimate: number | null;
  };
}

/** Reads the staged tarball, hands it to the signed internal ingest endpoint,
 *  writes the report's per-file objects to musebook-artifacts (plus the poster
 *  to musebook-public), publishes the version row, then clears staging. A
 *  rejection or any downstream failure throws — the queue retries, then DLQs. */
async function ingestArtifactBundle(env: Env, key: string, eventSize: number): Promise<void> {
  const db = await pgFreshJobs(env);
  let target:
    | {
        post_id: string;
        artifact_id: string;
        kind: string;
        uploader_user_id: string;
        visibility: string;
      }
    | undefined;
  try {
    const { rows } = await db.query<{
      post_id: string;
      artifact_id: string;
      kind: string;
      uploader_user_id: string;
      visibility: string;
    }>("select * from app.staged_artifact_target($1)", [key]);
    target = rows[0];
  } finally {
    await db.end();
  }
  if (target === undefined) return; // consumed or foreign — same ack as media

  const cap = BUNDLE_CAPS[target.kind] ?? DEFAULT_BUNDLE_CAP;
  if (eventSize > cap) {
    throw new Error(`artifact_ingest_rejected: staged bundle ${eventSize}B > ${cap}B cap`);
  }

  const src = await env.UPLOADS.get(key);
  if (src === null) throw new Error(`staged object vanished: ${key}`);
  const bundleBytes = new Uint8Array(await src.arrayBuffer());
  const body = JSON.stringify({
    artifact_id: target.artifact_id,
    kind: target.kind,
    bundle_b64: toB64(bundleBytes),
  });

  const signingKey = env.MB_INTERNAL_SIGNING_KEY;
  if (signingKey === undefined) throw new Error("MB_INTERNAL_SIGNING_KEY not configured");
  const keyId = env.MB_INTERNAL_KEY_ID;
  if (keyId === undefined || keyId === "") throw new Error("MB_INTERNAL_KEY_ID not configured");
  const signed = signInternalRequest({
    method: "POST",
    url: ARTIFACT_INGEST_URL,
    body,
    privateKeyPkcs8B64: signingKey,
    keyId,
  });
  const res = await fetch(ARTIFACT_INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  });
  if (!res.ok) {
    throw new Error(`artifact_ingest_failed: HTTP ${res.status}`);
  }
  const report: IngestReport = await res.json();
  if (!report.ok || report.version === undefined || report.files === undefined) {
    throw new Error(
      `artifact_ingest_rejected: ${report.rejection?.code ?? "unknown"} ${report.rejection?.message ?? ""}`,
    );
  }

  const version = report.version;
  const visibility = target.visibility === "private" ? "private" : "public";
  for (const file of report.files) {
    await env.ARTIFACTS.put(`a/${visibility}/${version}/${file.path}`, fromB64(file.content_b64), {
      httpMetadata: { contentType: file.content_type },
    });
  }

  let posterUrl: string | null = null;
  if (report.poster != null) {
    const posterBytes = fromB64(report.poster.content_b64);
    const digest = new crypto.DigestStream("SHA-256");
    await new Response(posterBytes).body!.pipeTo(digest);
    const sum = await digest.digest;
    const posterSha = [...new Uint8Array(sum)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const posterKey = `t/${posterSha}/1200.webp`;
    await env.PUBLIC_MEDIA.put(posterKey, posterBytes, {
      httpMetadata: { contentType: report.poster.content_type },
    });
    posterUrl = `https://cdn.musebook.dev/${posterKey}`;
  }

  const m = report.metrics ?? {
    total_bytes: 0,
    file_count: report.files.length,
    gzip_bytes: 0,
    triangle_count: null,
    texture_bytes: null,
    draw_call_estimate: null,
  };
  const jobs = await pgFreshJobs(env);
  try {
    await jobs.query(
      `select app.publish_artifact_version($1,$2,($3::text)::jsonb,$4,$5,$6,$7,$8::bigint,$9,$10::bigint,$11,$12::bigint,$13,($14::text)::jsonb,$15)`,
      [
        target.artifact_id,
        version,
        JSON.stringify(report.manifest ?? {}),
        `a/${visibility}/${version}`,
        visibility,
        report.entry_path ?? "index.html",
        posterUrl,
        String(m.total_bytes),
        m.file_count,
        String(m.gzip_bytes),
        m.triangle_count,
        m.texture_bytes,
        m.draw_call_estimate,
        JSON.stringify(report),
        target.uploader_user_id,
      ],
    );
    await jobs.query("select app.clear_staged_upload($1)", [key]);
  } finally {
    await jobs.end();
  }

  await env.UPLOADS.delete(key);
}
