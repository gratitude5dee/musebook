import { describe, expect, it, vi } from "vitest";
import { inLabelSample, sessionHash, writePoint } from "../src/index.js";

const BASE = {
  postId: "post-1",
  action: "impression",
  plane: "human" as const,
  slateId: "slate-1",
  weightsVersion: "none",
  modelVersion: "reverse_chron",
  sampleRate: 1.0,
};

describe("writePoint", () => {
  it("writes one data point with the 20/20 column layout", () => {
    const writeDataPoint = vi.fn();
    writePoint({ writeDataPoint } as unknown as AnalyticsEngineDataset, BASE);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const arg = writeDataPoint.mock.calls[0]?.[0] as {
      indexes: string[];
      blobs: string[];
      doubles: number[];
    };
    expect(arg.indexes).toEqual(["post-1"]);
    expect(arg.blobs).toHaveLength(20);
    expect(arg.doubles).toHaveLength(20);
    expect(arg.blobs[0]).toBe("impression");
    expect(arg.doubles[2]).toBe(1.0); // sample_rate is REQUIRED — never defaulted
    expect(arg.doubles[6]).toBe(1); // n
  });

  it("null postId indexes as '-' and optionals default", () => {
    const writeDataPoint = vi.fn();
    writePoint({ writeDataPoint } as unknown as AnalyticsEngineDataset, {
      action: "muse.heartbeat",
      plane: "agent",
      slateId: "s",
      weightsVersion: "w",
      modelVersion: "m",
      sampleRate: 1.0,
    });
    const arg = writeDataPoint.mock.calls[0]?.[0] as { indexes: string[]; blobs: string[] };
    expect(arg.indexes).toEqual(["-"]);
    expect(arg.blobs[6]).toBe("ok"); // outcome default
    expect(arg.blobs[12]).toBe("page"); // route_class default
  });

  it("never throws — a broken binding must not fail a request (§13.5.4)", () => {
    const ds = {
      writeDataPoint: () => {
        throw new Error("down");
      },
    } as unknown as AnalyticsEngineDataset;
    expect(() => writePoint(ds, BASE)).not.toThrow();
  });
});

describe("inLabelSample", () => {
  it("is deterministic — same session id, same answer, every isolate", () => {
    const id = crypto.randomUUID();
    expect(inLabelSample(id, 0.5)).toBe(inLabelSample(id, 0.5));
    expect(sessionHash(id)).toBe(sessionHash(id));
  });

  it("rate 1.0 includes every session; 0.0 excludes all", () => {
    const id = crypto.randomUUID();
    expect(inLabelSample(id, 1)).toBe(true);
    expect(inLabelSample(id, 0)).toBe(false);
  });

  it("a 50% rate partitions the space on the hash", () => {
    const ids = Array.from({ length: 400 }, () => crypto.randomUUID());
    const inCount = ids.filter((id) => inLabelSample(id, 0.5)).length;
    // Not a probability test — the function is a mod-10000 hash, so the split
    // is exact within binning error, never flaky.
    expect(inCount).toBeGreaterThan(100);
    expect(inCount).toBeLessThan(300);
  });
});
