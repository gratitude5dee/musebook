// packages/kernel/test/fail-closed.test.ts — spine invariant 9 (§6.13).
// A thrown access check DENIES: it never serves bytes. A throwing GrantPort and a
// throwing PaymentPort each produce allow:false and a zero-length rendered body.
import { describe, expect, it } from "vitest";
import { createKernel } from "../src/index.js";
import { stubPorts } from "./fixtures/ports.js";
import { HFAP, GATED } from "./fixtures/resources.js";
import { HUMAN, AGENT } from "./fixtures/actors.js";

describe("fail-closed", () => {
  it("a throwing GrantPort produces allow:false and a zero-length body", async () => {
    const logEvents: Array<Record<string, unknown>> = [];
    const kernel = createKernel(stubPorts({ grantsThrow: true, logEvents }));
    const decision = await kernel.resolveAccess(HFAP, AGENT);

    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("kernel_error");
      expect(decision.httpStatus).toBe(503);
      expect(decision.bodyKind).toBe("empty");
    }
    expect(logEvents.some((e) => e.msg === "resolveAccess threw")).toBe(true);

    for (const rep of ["html", "markdown", "json", "mcp"] as const) {
      const rendered = await kernel.renderResource(HFAP, rep, decision);
      expect(rendered.body).not.toContain("MUSEBOOK_PAID_BODY_MARKER_7f3a");
      if (rep === "markdown") expect(rendered.body).toBe("");
    }
  });

  it("a throwing PaymentPort produces allow:false and a zero-length body", async () => {
    const kernel = createKernel(stubPorts({ paymentsThrow: true }));
    const decision = await kernel.resolveAccess(GATED, HUMAN);

    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("kernel_error");
      expect(decision.httpStatus).toBe(503);
      expect(decision.bodyKind).toBe("empty");
    }

    const rendered = await kernel.renderResource(GATED, "markdown", decision);
    expect(rendered.body).toBe("");
  });
});
