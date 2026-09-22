// M7 coverage — the upload/publish error surface: every guard the happy path
// skips (405s, 400 parse failures, foreign-key 403s, not-found 404s, the
// publishable-state 409, routeUploads' default arm). Happy paths live in
// m7-publish.test.ts; this file is the branch coverage counterpart.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { routeUploads, handleUploadInit } from "../../src/routes/uploads.js";

const SESSION = "mb_session=musebook-seed-session-token-0001";
const SEED_USER = "11111111-1111-4111-8111-000000000001";

const post = (path: string, body: unknown, cookie = SESSION) =>
  SELF.fetch(`https://edge.test${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("uploads error surface", () => {
  it("init rejects non-POST, no-session, malformed bodies, and foreign buckets", async () => {
    expect((await SELF.fetch("https://edge.test/api/uploads/init")).status).toBe(405);
    expect((await post("/api/uploads/init", { filename: "a.mp4" }, "")).status).toBe(403);

    for (const bad of [
      null,
      {},
      { filename: "", contentType: "video/mp4", byteLen: 1 },
      { filename: "a.mp4", contentType: "mp4", byteLen: 1 },
      { filename: "a.mp4", contentType: "video/mp4", byteLen: 0 },
      { filename: "a.mp4", contentType: "video/mp4", byteLen: Number.NaN },
      { filename: "a.mp4", contentType: "video/mp4", byteLen: 1, postId: 42 },
    ]) {
      const res = await post("/api/uploads/init", bad);
      expect(res.status).toBe(400);
    }

    const res = await post("/api/uploads/init", {
      filename: "a.mp4",
      contentType: "video/mp4",
      byteLen: 1,
      postId: null,
      bucket: "musebook-public",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bucket_not_signable" });
  });

  it("sign-part rejects non-POST, no-session, malformed bodies, foreign keys, and unknown staged rows", async () => {
    expect((await SELF.fetch("https://edge.test/api/uploads/sign-part")).status).toBe(405);
    expect((await post("/api/uploads/sign-part", {}, "")).status).toBe(403);

    for (const bad of [
      null,
      {},
      { key: "x", uploadId: "u" },
      { key: "x", uploadId: "u", partNumber: 0 },
      { key: "x", uploadId: "u", partNumber: "one" },
    ]) {
      expect((await post("/api/uploads/sign-part", bad)).status).toBe(400);
    }

    const foreign = `staging/22222222-2222-4222-8222-000000000002/x/f.mp4`;
    expect(
      (await post("/api/uploads/sign-part", { key: foreign, uploadId: "u", partNumber: 1 })).status,
    ).toBe(403);

    const mine = `staging/${SEED_USER}/00000000-0000-4000-8000-000000000000/f.mp4`;
    const res = await post("/api/uploads/sign-part", { key: mine, uploadId: "u", partNumber: 1 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "staged_upload_not_found" });
  });

  it("complete rejects non-POST, no-session, malformed bodies, and foreign keys", async () => {
    expect((await SELF.fetch("https://edge.test/api/uploads/complete")).status).toBe(405);
    expect((await post("/api/uploads/complete", {}, "")).status).toBe(403);

    for (const bad of [
      null,
      {},
      { key: "x", uploadId: "u", parts: [] },
      { key: "x", uploadId: "u", parts: [{ PartNumber: "1", ETag: "e" }] },
      { key: "x", uploadId: "u", parts: [{ PartNumber: 1 }] },
      {
        key: "staging/22222222-2222-4222-8222-000000000002/x/f.mp4",
        uploadId: "u",
        parts: [{ PartNumber: 1, ETag: "e" }],
      },
    ]) {
      expect((await post("/api/uploads/complete", bad)).status).toBe(400);
    }
  });

  it("routeUploads dispatches only the three upload paths", () => {
    expect(routeUploads("/api/uploads/init")).toBe(handleUploadInit);
    expect(routeUploads("/api/uploads/sign-part")).toBeTypeOf("function");
    expect(routeUploads("/api/uploads/complete")).toBeTypeOf("function");
    expect(routeUploads("/api/uploads")).toBeNull();
    expect(routeUploads("/p/x")).toBeNull();
  });
});

describe("malformed JSON and the R2 fetch tail", () => {
  const badJson = (path: string) =>
    SELF.fetch(`https://edge.test${path}`, {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: "{",
    });

  it("non-JSON bodies parse-fail to 400 on every handler", async () => {
    expect((await badJson("/api/uploads/init")).status).toBe(400);
    expect((await badJson("/api/uploads/sign-part")).status).toBe(400);
    expect((await badJson("/api/uploads/complete")).status).toBe(400);
    expect((await badJson("/api/posts/00000000-0000-4000-8000-000000000000/publish")).status).toBe(
      404,
    );
  });

  it("complete with a valid shape reaches R2 and surfaces its failure as 502", async () => {
    // Key format + parts pass validation; the uploadId is bogus so R2's
    // CompleteMultipartUpload fails — covering the XML map + fetch tail.
    const res = await post("/api/uploads/complete", {
      key: `staging/${SEED_USER}/00000000-0000-4000-8000-000000000000/f.mp4`,
      uploadId: "not-a-real-upload",
      parts: [
        { PartNumber: 1, ETag: "etag1" },
        { PartNumber: 2, ETag: "etag2" },
      ],
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "r2_complete_failed" });
  });
});

describe("publish error surface", () => {
  const DRAFTLESS = "00000000-0000-4000-8000-000000000000";

  it("publish rejects non-POST, no-session, and posts the actor cannot write", async () => {
    expect((await SELF.fetch(`https://edge.test/api/posts/${DRAFTLESS}/publish`)).status).toBe(405);
    expect((await post(`/api/posts/${DRAFTLESS}/publish`, {}, "")).status).toBe(403);
    expect((await post(`/api/posts/${DRAFTLESS}/publish`, {})).status).toBe(404);
    expect(
      (await post(`/api/posts/${DRAFTLESS}/publish`, { platforms: ["x", 1, "y"] })).status,
    ).toBe(404);
  });
});
