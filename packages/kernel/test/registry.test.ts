// packages/kernel/test/registry.test.ts — the registry isolation rule (§6.3).
// Two interleaved createKernel instances with different ports never observe each
// other's; the module-level getPorts() throws before configureKernel().
import { describe, expect, it } from "vitest";
import { createKernel } from "../src/index.js";
import { stubPorts } from "./fixtures/ports.js";
import { GATED } from "./fixtures/resources.js";
import { HUMAN } from "./fixtures/actors.js";

describe("kernel registry", () => {
  it("interleaved instances never observe each other's ports", async () => {
    const a = createKernel(stubPorts());
    const b = createKernel(stubPorts({ mode: "off" }));

    // Interleave: a gated post on `a` (live ports) is a 402; on `b` (mode 'off')
    // the same call must serve mode_free. If b saw a's ports it would deny too.
    const dA = a.resolveAccess(GATED, HUMAN);
    const dB = b.resolveAccess(GATED, HUMAN);
    const [rA, rB] = await Promise.all([dA, dB]);
    expect(!rA.allow && rA.reason).toBe("payment_required");
    expect(rB.allow && rB.reason).toBe("mode_free");
  });

  it("module-level resolveAccess throws before configureKernel", async () => {
    // Fresh module graph: the registry cell starts null.
    const fresh = await import("../src/index.ts?fresh=registry-test");
    await expect(fresh.variantIntentFor("00000000-0000-4000-8000-000000000001")).rejects.toThrow(
      "configureKernel",
    );
  });
});
