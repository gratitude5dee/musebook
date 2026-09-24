// packages/ui/test/artifact-frame.test.tsx — §11.14's verbatim guard.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactFrame } from "../src/ArtifactFrame";

describe("ArtifactFrame", () => {
  it("never grants allow-same-origin", () => {
    const html = renderToStaticMarkup(<ArtifactFrame src="https://x/y" title="t" />);
    expect(html).toContain('sandbox="allow-scripts allow-pointer-lock"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("allow-top-navigation");
    expect(html).not.toContain("allow-forms");
  });
});
