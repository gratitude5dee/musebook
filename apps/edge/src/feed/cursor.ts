// apps/edge/src/feed/cursor.ts — §9.17's client cursor, verbatim:
// base64url(JSON.stringify({ slateId, offset, weightsVersion })). Opaque to the
// client — it is a bookmark into one immutable slate row, never a query.
import type { FeedCursor } from "./types.js";

export function encodeCursor(c: FeedCursor): string {
  const json = JSON.stringify({
    slateId: c.slateId,
    offset: c.offset,
    weightsVersion: c.weightsVersion,
  });
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCursor(raw: string | null | undefined): FeedCursor | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const b64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const pad = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const parsed: unknown = JSON.parse(atob(pad));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as FeedCursor).slateId !== "string" ||
      typeof (parsed as FeedCursor).offset !== "number" ||
      typeof (parsed as FeedCursor).weightsVersion !== "string"
    ) {
      return null;
    }
    return parsed as FeedCursor;
  } catch {
    return null;
  }
}
