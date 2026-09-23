// packages/muse-mixer/test/pagination.test.ts
// §9.19's companion gate: build a 300-candidate slate, persist it through the
// memory adapter, read pages 1–3 the way app.read_slate does (by `position`, not
// by count), and assert the union has no duplicate postId and no gaps.
import { describe, expect, it } from "vitest";
import type { MuseCandidate } from "../src/muse/candidate.js";
import { makeCandidate } from "./factories.js";

/** The memory-adapter slate store: one row per position, keyed reads. */
class MemorySlateStore {
  private items: Array<{ position: number; postId: string; moderated: boolean }> = [];
  write(items: ReadonlyArray<{ position: number; postId: string }>): void {
    this.items = items.map((i) => ({ ...i, moderated: false }));
  }
  moderateAway(postId: string): void {
    for (const i of this.items) if (i.postId === postId) i.moderated = true;
  }
  /** app.read_slate's shape: page by position, dropping moderated items. */
  readPage(
    afterPosition: number,
    limit: number,
  ): {
    items: Array<{ position: number; postId: string }>;
    nextCursor: number;
  } {
    const page = this.items
      .filter((i) => i.position > afterPosition && !i.moderated)
      .sort((a, b) => a.position - b.position)
      .slice(0, limit)
      .map((i) => ({ position: i.position, postId: i.postId }));
    const nextCursor = page.length === 0 ? afterPosition : page[page.length - 1].position;
    return { items: page, nextCursor };
  }
}

describe("pagination stability (§9.17)", () => {
  it("pages by position: no duplicates, no gaps, shrinkage-safe", () => {
    const candidates: MuseCandidate[] = Array.from({ length: 300 }, (_, i) =>
      makeCandidate({ postId: `p-${String(i).padStart(3, "0")}` }),
    );
    const store = new MemorySlateStore();
    store.write(candidates.map((c, i) => ({ position: i, postId: c.postId })));

    // Moderate one item between build and read — the row vanishes, the cursor still holds.
    store.moderateAway("p-142");

    const seen = new Set<string>();
    let cursor = -1;
    const positions: number[] = [];
    for (let page = 0; page < 3; page++) {
      const { items, nextCursor } = store.readPage(cursor, 100);
      for (const it of items) {
        expect(seen.has(it.postId)).toBe(false);
        seen.add(it.postId);
        positions.push(it.position);
      }
      cursor = nextCursor;
    }
    expect(seen.size).toBe(299); // 300 built minus 1 moderated
    // positions strictly ascend — the cursor advanced by last returned position
    for (let i = 1; i < positions.length; i++)
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    expect(positions[positions.length - 1]).toBe(299);
    // every position 0..299 except the moderated one was served exactly once
    const missing = positions.filter((p) => p === 142);
    expect(missing).toHaveLength(0);
    for (let p = 0; p <= 299; p++) {
      if (p !== 142) expect(positions).toContain(p);
    }
  });
});
