// apps/edge/src/routes/uploads.ts — §11.7.3. THE only file in the plan that
// mints a presigned URL. Presigns are for uploads and only uploads: they leak
// the account's R2 endpoint, route around the zone entirely (no cache, no bot
// gate, no Web Bot Auth), and are bearer tokens — so the credential pair is
// scoped to musebook-uploads alone and X-Amz-Expires is R2_PRESIGN_TTL_S (900),
// never the 604800 maximum.
//
// Multipart only, PUT-only: R2 presigns do not support POST, so an HTML form
// upload is not an option — the browser issues real PUTs per part.
import { AwsClient } from "aws4fetch";
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { bound, fresh } from "../db/client.js";

export const UPLOADS_BUCKET = "musebook-uploads";
const PART_MIN_BYTES = 5 * 1024 * 1024; // every part but the last
const MAX_PARTS = 10_000;

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

function r2(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: bound(env.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID"),
    secretAccessKey: bound(env.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
  });
}

const base = (env: Env, key: string): string =>
  `https://${bound(env.CF_ACCOUNT_ID, "CF_ACCOUNT_ID")}.r2.cloudflarestorage.com/${UPLOADS_BUCKET}/${key}`;

/** One presigned PUT per part (§11.7.3 step 2). signQuery puts the signature
 *  in the URL; X-Amz-Expires rides the query string verbatim. */
export async function presignPartPut(
  env: Env,
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  const u = new URL(base(env, key));
  u.searchParams.set("partNumber", String(partNumber));
  u.searchParams.set("uploadId", uploadId);
  u.searchParams.set("X-Amz-Expires", env.R2_PRESIGN_TTL_S ?? "900");
  return (await r2(env).sign(new Request(u, { method: "PUT" }), { aws: { signQuery: true } })).url;
}

const safeFilename = (name: string): string =>
  name
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128) || "file";

interface InitBody {
  filename: string;
  contentType: string;
  byteLen: number;
  postId: string | null;
  bucket: string; // client may name it; anything but musebook-uploads is a 400
}

function parseInit(raw: unknown): InitBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.filename !== "string" || o.filename.length === 0) return null;
  if (typeof o.contentType !== "string" || !o.contentType.includes("/")) return null;
  if (typeof o.byteLen !== "number" || !Number.isFinite(o.byteLen) || o.byteLen <= 0) return null;
  if (o.postId !== undefined && o.postId !== null && typeof o.postId !== "string") return null;
  return {
    filename: o.filename,
    contentType: o.contentType,
    byteLen: o.byteLen,
    postId: typeof o.postId === "string" ? o.postId : null,
    bucket: typeof o.bucket === "string" ? o.bucket : UPLOADS_BUCKET,
  };
}

/** POST /api/uploads/init — mint the staging key, create the R2 multipart
 *  upload, and persist the key→post linkage the r2-events consumer promotes on. */
export async function handleUploadInit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "human_creator" || actor.userId === null) {
    return json({ error: "forbidden" }, 403);
  }
  const body = parseInit(await request.json().catch(() => null));
  if (body === null) return json({ error: "bad_request" }, 400);
  if (body.bucket !== UPLOADS_BUCKET) return json({ error: "bucket_not_signable" }, 400);

  const key = `staging/${actor.userId}/${crypto.randomUUID()}/${safeFilename(body.filename)}`;

  const init = await r2(env).fetch(`${base(env, key)}?uploads`, { method: "POST" });
  if (!init.ok) return json({ error: "r2_init_failed" }, 502);
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await init.text())?.[1];
  if (uploadId === undefined) return json({ error: "r2_init_failed" }, 502);

  const db = fresh(env);
  try {
    await db.query("select app.init_staged_upload($1::uuid, $2::uuid, $3, $4, $5, $6::bigint)", [
      actor.userId,
      body.postId,
      key,
      uploadId,
      body.contentType,
      Math.trunc(body.byteLen),
    ]);
  } finally {
    await db.end().catch(() => undefined);
  }

  // Part sizing: smallest multiple-of-5MiB that keeps the count under 10k.
  const partSize = Math.max(PART_MIN_BYTES, Math.ceil(body.byteLen / MAX_PARTS));
  const parts = Math.ceil(body.byteLen / partSize);
  return json({ key, uploadId, partSize, parts });
}

/** POST /api/uploads/sign-part — one presigned PUT per part, only for a key
 *  this user staged. */
export async function handleUploadSignPart(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "human_creator" || actor.userId === null) {
    return json({ error: "forbidden" }, 403);
  }
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const key = typeof raw?.key === "string" ? raw.key : null;
  const uploadId = typeof raw?.uploadId === "string" ? raw.uploadId : null;
  const partNumber = typeof raw?.partNumber === "number" ? Math.trunc(raw.partNumber) : NaN;
  if (key === null || uploadId === null || !Number.isFinite(partNumber) || partNumber < 1) {
    return json({ error: "bad_request" }, 400);
  }
  if (!key.startsWith(`staging/${actor.userId}/`)) return json({ error: "forbidden" }, 403);

  const db = fresh(env);
  try {
    const { rows } = await db.query<{ uploader_user_id: string }>(
      "select uploader_user_id from app.staged_upload_target($1)",
      [key],
    );
    if (rows[0]?.uploader_user_id !== actor.userId) {
      return json({ error: "staged_upload_not_found" }, 404);
    }
  } finally {
    await db.end().catch(() => undefined);
  }

  const url = await presignPartPut(env, key, uploadId, partNumber);
  return json({ url, partNumber });
}

/** POST /api/uploads/complete — the client's [{PartNumber, ETag}] goes to R2
 *  verbatim; the object-create event lands on musebook-r2-events and the
 *  consumer promotes the bytes — a client that closes its laptop here still
 *  produces an asset (§11.7.3). Optionally re-links the staged key to a post. */
export async function handleUploadComplete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "human_creator" || actor.userId === null) {
    return json({ error: "forbidden" }, 403);
  }
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const key = typeof raw?.key === "string" ? raw.key : null;
  const uploadId = typeof raw?.uploadId === "string" ? raw.uploadId : null;
  const postId = typeof raw?.postId === "string" ? raw.postId : null;
  const parts = Array.isArray(raw?.parts) ? raw.parts : null;
  if (
    key === null ||
    uploadId === null ||
    parts === null ||
    parts.length === 0 ||
    !parts.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Record<string, unknown>).PartNumber === "number" &&
        typeof (p as Record<string, unknown>).ETag === "string",
    ) ||
    !key.startsWith(`staging/${actor.userId}/`)
  ) {
    return json({ error: "bad_request" }, 400);
  }

  const db = fresh(env);
  try {
    if (postId !== null) {
      try {
        await db.query("select app.link_staged_upload($1::uuid, $2, $3::uuid)", [
          actor.userId,
          key,
          postId,
        ]);
      } catch (e) {
        if ((e as { code?: string }).code === "P0002") {
          return json({ error: "staged_upload_not_found" }, 404);
        }
        throw e;
      }
    }
  } finally {
    await db.end().catch(() => undefined);
  }

  const xml = `<CompleteMultipartUpload>${parts
    .map(
      (p) =>
        `<Part><PartNumber>${(p as { PartNumber: number }).PartNumber}</PartNumber><ETag>${
          (p as { ETag: string }).ETag
        }</ETag></Part>`,
    )
    .join("")}</CompleteMultipartUpload>`;
  const done = await r2(env).fetch(`${base(env, key)}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: xml,
  });
  if (!done.ok) return json({ error: "r2_complete_failed" }, 502);
  return json({ key, status: "complete" });
}

export function routeUploads(pathname: string): typeof handleUploadInit | null {
  switch (pathname) {
    case "/api/uploads/init":
      return handleUploadInit;
    case "/api/uploads/sign-part":
      return handleUploadSignPart;
    case "/api/uploads/complete":
      return handleUploadComplete;
    default:
      return null;
  }
}
