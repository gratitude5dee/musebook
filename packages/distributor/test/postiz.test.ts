import { describe, expect, it } from "vitest";
import { PostizClient, PostizHttpError } from "../src/postiz/client";
import type { PostizCreatePostBody } from "../src/postiz/types";
import { extractProviderFromValidationError, sendWithPartialRetry } from "../src/send";

const body3 = (): PostizCreatePostBody => ({
  type: "schedule",
  date: "2026-09-22T13:00:00.000Z",
  shortLink: false,
  tags: [{ value: "musebook", label: "musebook" }],
  posts: [
    {
      integration: { id: "chan-x" },
      value: [{ content: `x body https://musebook.dev/p/1`, image: [] }],
      settings: {},
    },
    {
      integration: { id: "chan-bs" },
      value: [{ content: `bs body https://musebook.dev/p/1`, image: [] }],
      settings: {},
    },
    {
      integration: { id: "chan-li" },
      value: [{ content: `li body https://musebook.dev/p/1`, image: [] }],
      settings: {},
    },
  ],
});

function recordingFetch(
  calls: { url: string; init: RequestInit | undefined }[],
  response: () => Response,
) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response();
  };
}

describe("PostizClient contract", () => {
  it("gate check 1: a 3-channel fan-out is ONE POST to /public/v1/posts", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = new PostizClient({
      baseUrl: "https://postiz.musebook.dev/api",
      apiKey: "org-key",
      fetchImpl: recordingFetch(
        calls,
        () =>
          new Response(
            JSON.stringify([
              { postId: "p1", integration: "chan-x" },
              { postId: "p2", integration: "chan-bs" },
              { postId: "p3", integration: "chan-li" },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    });
    const res = await client.createPosts(body3());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://postiz.musebook.dev/api/public/v1/posts");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("org-key"); // raw key, no Bearer
    expect(res).toHaveLength(3);
  });

  it("rejects a non-2xx with PostizHttpError carrying the body", async () => {
    const client = new PostizClient({
      baseUrl: "https://postiz.example/api",
      apiKey: "k",
      fetchImpl: async () =>
        new Response(JSON.stringify({ provider: "x", name: "n", error: "e" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    });
    await expect(client.createPosts(body3())).rejects.toBeInstanceOf(PostizHttpError);
  });
});

describe("sendWithPartialRetry", () => {
  it("extracts the provider slug from a PostValidationException body", () => {
    expect(
      extractProviderFromValidationError({
        provider: "x",
        name: "PostValidationException",
        error: "bad",
      }),
    ).toBe("x");
    expect(extractProviderFromValidationError({})).toBeNull();
    expect(extractProviderFromValidationError(null)).toBeNull();
  });

  it("400 -> marks the offender and retries ONCE without it", async () => {
    let calls = 0;
    const client = new PostizClient({
      baseUrl: "https://postiz.example/api",
      apiKey: "k",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ provider: "x", name: "PostValidationException", error: "bad" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify([
            { postId: "p2", integration: "chan-bs" },
            { postId: "p3", integration: "chan-li" },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });
    const failed: string[] = [];
    const providerOf = (e: PostizCreatePostBody["posts"][number]) =>
      e.integration.id === "chan-x" ? "x" : e.integration.id === "chan-bs" ? "bs" : "li";
    const res = await sendWithPartialRetry(client, body3(), {
      markJobFailed: async (p) => {
        failed.push(p);
      },
      providerOf,
    });
    expect(failed).toEqual(["x"]);
    expect(res).toHaveLength(2);
    expect(calls).toBe(2);
  });
});
