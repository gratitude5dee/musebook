import { describe, expect, it } from "vitest";
import { countEffective, countGraphemes, countLength } from "../src/count";

const URL_ = "https://musebook.dev/p/some-post";

describe("countEffective", () => {
  it("counts UTF-16 code units for utf16 platforms", () => {
    expect(countEffective("utf16", "hello", null)).toBe(5);
    // emoji are surrogate pairs on the UTF-16 surface
    expect(countEffective("utf16", "a\u{1F600}", null)).toBe(3);
  });

  it("counts grapheme clusters for graphemes platforms", () => {
    expect(countEffective("graphemes", "hello", null)).toBe(5);
    // family emoji = one grapheme, many code units
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(countEffective("graphemes", family, null)).toBe(1);
    expect(countGraphemes(family)).toBe(1);
  });

  it("counts UTF-8 bytes for utf8_bytes platforms", () => {
    expect(countEffective("utf8_bytes", "héllo", null)).toBe(6);
    expect(countEffective("utf8_bytes", "hello", null)).toBe(5);
  });

  it("counts x_weighted via twitter-text (a URL always costs 23)", () => {
    const n = countLength("x_weighted", `see ${URL_} now`);
    expect(n).toBe(countLength("x_weighted", "see  now") + 23);
    expect(countEffective("x_weighted", `see ${URL_} now`, null)).toBe(n);
  });

  it("substitutes the placeholder when urlCountsAsChars is set", () => {
    const n = countEffective("utf16", `link ${URL_} end`, 1);
    expect(n).toBe("link  end".length + 1);
  });

  it("does NOT substitute when urlCountsAsChars is null", () => {
    const n = countEffective("utf16", `link ${URL_} end`, null);
    expect(n).toBe(`link ${URL_} end`.length);
  });
});
