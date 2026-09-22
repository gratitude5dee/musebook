// apps/web/lib/compose/transport.ts — the two verbs that ride
// musebook-edge directly from the browser: publish hits /api/posts/{id}/publish
// (mb_session cookie → human_creator), uploads hit the presign trio (§11.7.3).
// The browser hashes the file itself so the markdown can name the final
// content-addressed key BEFORE the promotion consumer runs.
"use client";

import { assetKey, assetUrl } from "@musebook/media";

export async function publishPost(postId: string, platforms: string[]): Promise<void> {
  const res = await fetch(`/api/posts/${postId}/publish`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ platforms }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `publish_${res.status}`);
  }
}

async function sha256File(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const sum = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface InitResponse {
  key: string;
  uploadId: string;
  partSize: number;
  parts: number; // part count — parts are 1..parts
}

export async function uploadMedia(
  file: File,
  postId: string | null,
  opts: { storage: "r2_public" | "r2_paid" },
): Promise<{ markdown: string }> {
  const init = await fetch("/api/uploads/init", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      byteLen: file.size,
      postId,
      bucket: "musebook-uploads",
    }),
  });
  if (!init.ok) {
    const body = (await init.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `upload_init_${init.status}`);
  }
  const { key, uploadId, partSize, parts } = (await init.json()) as InitResponse;

  const etags: { PartNumber: number; ETag: string }[] = [];
  for (let partNumber = 1; partNumber <= parts; partNumber++) {
    const sign = await fetch("/api/uploads/sign-part", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, uploadId, partNumber }),
    });
    if (!sign.ok) throw new Error(`sign_part_${sign.status}`);
    const { url } = (await sign.json()) as { url: string };
    const start = (partNumber - 1) * partSize;
    const put = await fetch(url, {
      method: "PUT",
      body: file.slice(start, Math.min(start + partSize, file.size)),
    });
    if (!put.ok) throw new Error(`part_${partNumber}_${put.status}`);
    etags.push({ PartNumber: partNumber, ETag: put.headers.get("etag") ?? "" });
  }

  const complete = await fetch("/api/uploads/complete", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, uploadId, postId, parts: etags }),
  });
  if (!complete.ok) throw new Error(`complete_${complete.status}`);

  // The promotion consumer will land the object at exactly this key — the
  // same sha256, the same §11.7.2 builder — so the draft can name it now.
  const sha = await sha256File(file);
  const ext = file.name.includes(".")
    ? file.name.split(".").pop()!.toLowerCase()
    : (file.type.split("/")[1] ?? "bin");
  const url = assetUrl(opts.storage, assetKey(opts.storage, sha, ext));
  const md = file.type.startsWith("image/") ? `![${file.name}](${url})` : `[${file.name}](${url})`;
  return { markdown: md };
}
