// packages/classify/test/battery.contract.test.ts — §8.4/§8.5 shape contract.
// Runs under BOTH the node and workerd pools: the version hashes come from
// node:crypto, which must resolve inside workerd without a flag or a fail.
import { describe, expect, it } from "vitest";
import {
  POST_BATTERY,
  POST_BATTERY_LABELS,
  POST_BATTERY_TAGS,
  POST_BATTERY_FLAT,
  FLAT_LEAF_QUESTION,
  TOPIC_TAGS,
  AUDIENCE_LEVELS,
  QUALITY_LEVELS,
  AGENT_VALUE_LEVELS,
  QUESTION_SET_VERSION,
  TAXONOMY_VERSION,
  MUSEBOOK_TAXONOMY,
  LEAF_TO_PATH,
} from "../src/index.js";

describe("battery contract (§8.4)", () => {
  it("28 questions: 4 choice + 3 score + 9 flag nouls + 12 tag nouls", () => {
    const entries = Object.entries(POST_BATTERY);
    expect(entries).toHaveLength(28);
    const byType = entries.reduce<Record<string, number>>((m, [name, q]) => {
      m[`${name.startsWith("tag_") ? "tag" : "other"}:${q.type}`] =
        (m[`${name.startsWith("tag_") ? "tag" : "other"}:${q.type}`] ?? 0) + 1;
      return m;
    }, {});
    expect(byType["other:choice"]).toBe(4);
    expect(byType["other:score"]).toBe(3);
    expect(byType["other:noul"]).toBe(9);
    expect(byType["tag:noul"]).toBe(12);
  });

  it("LABELS + TAGS reconstruct the whole battery (question-set split)", () => {
    expect(Object.keys(POST_BATTERY_LABELS)).toHaveLength(16);
    expect(Object.keys(POST_BATTERY_TAGS)).toHaveLength(12);
    for (const name of Object.keys(POST_BATTERY_TAGS)) {
      expect(name.startsWith("tag_")).toBe(true);
    }
    expect({ ...POST_BATTERY_LABELS, ...POST_BATTERY_TAGS }).toEqual(POST_BATTERY);
  });

  it("every TOPIC_TAGS member has exactly one tag_* noul and vice versa", () => {
    const tagKeys = Object.keys(POST_BATTERY_TAGS).map((k) => k.slice(4));
    expect(tagKeys.sort()).toEqual([...TOPIC_TAGS].sort());
  });

  it("rubrics are 4 levels long, sorted, and carry an escape hatch on every choice", () => {
    for (const q of Object.values(POST_BATTERY)) {
      if (q.type === "choice") {
        const criteria = q.criteria as Record<string, string>;
        // Escape hatch is mandatory: none_of_these, or an other/none label.
        expect(
          "none_of_these" in criteria || "other" in criteria || "none" in criteria,
        ).toBe(true);
      } else if (q.type === "score") {
        expect(q.criteria).toHaveLength(4);
      }
    }
    expect(AUDIENCE_LEVELS).toHaveLength(4);
    expect(QUALITY_LEVELS).toHaveLength(4);
    expect(AGENT_VALUE_LEVELS).toHaveLength(4);
  });

  it("version hashes are 16-hex and stable across recomputation", async () => {
    const hex16 = /^[0-9a-f]{16}$/;
    expect(QUESTION_SET_VERSION).toMatch(hex16);
    expect(TAXONOMY_VERSION).toMatch(hex16);
    const { createHash } = await import("node:crypto");
    const recompute = (x: unknown) =>
      createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
    expect(recompute(POST_BATTERY)).toBe(QUESTION_SET_VERSION);
    expect(recompute(MUSEBOOK_TAXONOMY)).toBe(TAXONOMY_VERSION);
  });
});

describe("taxonomy contract (§8.5)", () => {
  it("3 roots / 10 L2 / 38 leaves, every leaf mapped to a 3-part path", () => {
    expect(Object.keys(MUSEBOOK_TAXONOMY)).toHaveLength(3);
    const l2 = Object.values(MUSEBOOK_TAXONOMY).reduce(
      (n, root) => n + Object.keys(root.children ?? {}).length,
      0,
    );
    expect(l2).toBe(10);
    expect(Object.keys(LEAF_TO_PATH)).toHaveLength(38);
    for (const path of Object.values(LEAF_TO_PATH)) {
      expect(path).toHaveLength(3);
    }
  });

  it("flat mode adds exactly one 39-leaf question (38 + none_of_these)", () => {
    const flat = POST_BATTERY_FLAT[FLAT_LEAF_QUESTION];
    expect(flat.type).toBe("choice");
    const criteria = flat.criteria as Record<string, string>;
    expect(Object.keys(criteria)).toHaveLength(39);
    expect(criteria).toHaveProperty("none_of_these");
    for (const [leaf, text] of Object.entries(criteria)) {
      if (leaf === "none_of_these") continue;
      expect(text).toBe(`Path: ${LEAF_TO_PATH[leaf].join(" > ")}`);
    }
    expect(Object.keys(POST_BATTERY_FLAT)).toHaveLength(29);
  });
});
