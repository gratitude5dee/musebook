import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

const SECRET = "test-edge-secret";
const req = (headers: Record<string, string> = {}) =>
  new NextRequest("https://musebook.dev/p/demo", { headers });

describe("proxy origin lockdown", () => {
  beforeEach(() => {
    vi.stubEnv("MUSEBOOK_EDGE_SECRET", SECRET);
    vi.stubEnv("MUSEBOOK_EDGE_SECRET_PREVIOUS", "");
    vi.stubEnv("VERCEL_ENV", "production");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("404s requests without the edge header in production", () => {
    const res = proxy(req());
    expect(res.status).toBe(404);
  });

  it("passes requests carrying the current secret", () => {
    const res = proxy(req({ "x-musebook-edge": SECRET }));
    expect(res.status).not.toBe(404);
  });

  it("accepts the previous secret during rotation", () => {
    vi.stubEnv("MUSEBOOK_EDGE_SECRET_PREVIOUS", "old-secret");
    const res = proxy(req({ "x-musebook-edge": "old-secret" }));
    expect(res.status).not.toBe(404);
  });

  it("skips the lockdown outside production", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = proxy(req());
    expect(res.status).not.toBe(404);
  });

  it("404s a wrong secret in production", () => {
    const res = proxy(req({ "x-musebook-edge": "not-the-secret" }));
    expect(res.status).toBe(404);
  });

  it("passes /.well-known/ untouched in production with no header", () => {
    const res = proxy(new NextRequest("https://musebook.dev/.well-known/acme-challenge/x"));
    expect(res.status).not.toBe(404);
  });

  it("accepts the previous secret with no current secret configured", () => {
    vi.stubEnv("MUSEBOOK_EDGE_SECRET", "");
    vi.stubEnv("MUSEBOOK_EDGE_SECRET_PREVIOUS", "old-secret");
    const res = proxy(req({ "x-musebook-edge": "old-secret" }));
    expect(res.status).not.toBe(404);
  });
});
