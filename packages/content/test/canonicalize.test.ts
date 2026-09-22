// canonicalize.test.ts — unit pins for the whitespace family and the
// CommonMark-preserving guards (fences, indented code, list ordinals).
import { describe, expect, it } from "vitest";
import { canonicalMarkdown } from "../src/canonicalize.js";

describe("canonicalMarkdown", () => {
  it("unifies CRLF and lone CR to LF", () => {
    expect(canonicalMarkdown("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("strips trailing spaces and tabs per line", () => {
    expect(canonicalMarkdown("a   \nb\t\t\n")).toBe("a\nb\n");
  });

  it("collapses trailing blank lines to one final newline", () => {
    expect(canonicalMarkdown("a\n\n\n\n")).toBe("a\n");
    expect(canonicalMarkdown("a")).toBe("a\n");
  });

  it("empty input canonicalizes to the empty string", () => {
    expect(canonicalMarkdown("")).toBe("");
    expect(canonicalMarkdown("\n\n\n")).toBe("");
  });

  it("rewrites list indent widths to two spaces per depth ordinal", () => {
    const doc = "- a\n    - b\n      - c\n";
    expect(canonicalMarkdown(doc)).toBe("- a\n  - b\n    - c\n");
  });

  it("collapses marker-space runs to one space", () => {
    expect(canonicalMarkdown("-   a\n-    b\n")).toBe("- a\n- b\n");
  });

  it("preserves ordered and paren markers", () => {
    expect(canonicalMarkdown("1. a\n2) b\n+ c\n* d\n")).toBe("1. a\n2) b\n+ c\n* d\n");
  });

  it("is idempotent", () => {
    const doc = "# T\n\npara  \r\n- a\n    - b\r\n```\n- keep\n```\n\n\n";
    const once = canonicalMarkdown(doc);
    expect(canonicalMarkdown(once)).toBe(once);
  });

  it("leaves fenced regions byte-identical (marker lines included)", () => {
    const doc = "```\n- not a list   \n      indented\n```\n";
    expect(canonicalMarkdown(doc)).toBe("```\n- not a list\n      indented\n```\n");
  });

  it("does not treat a 4-space top-level line as a list marker", () => {
    // Indented code at top level: the marker-looking text stays literal.
    const doc = "para\n\n    - code not list\n";
    expect(canonicalMarkdown(doc)).toBe("para\n\n    - code not list\n");
  });

  it("keeps interior blank lines untouched", () => {
    expect(canonicalMarkdown("a\n\n\nb\n")).toBe("a\n\n\nb\n");
  });
});
