import { describe, expect, it } from "vitest";
import { planSendBuckets, type PlanChannel } from "../src/plan";

const ch = (id: string, stagger: number): PlanChannel => ({
  id,
  platform: "x",
  postizChannelId: `postiz-${id}`,
  staggerSeconds: stagger,
  concurrencyCeiling: null,
});

describe("planSendBuckets", () => {
  it("groups channels by stagger offset into distinct publish instants", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    const { buckets } = planSendBuckets(
      [ch("a", 0), ch("b", 0), ch("c", 60), ch("d", 120), ch("e", 60)],
      now,
    );
    expect(buckets.size).toBe(3);
    const instants = [...buckets.keys()].sort();
    expect(instants[0]).toBe(now.getTime() + 60_000); // now+60s, stagger 0
    expect(instants[1]).toBe(now.getTime() + 60_000 + 60_000);
    expect(instants[2]).toBe(now.getTime() + 60_000 + 120_000);
    expect(buckets.get(instants[0]!)).toEqual(["a", "b"]);
    expect(buckets.get(instants[1]!)).toEqual(["c", "e"]);
    expect(buckets.get(instants[2]!)).toEqual(["d"]);
  });

  it("empty fan-out produces no sends", () => {
    expect(planSendBuckets([], new Date()).buckets.size).toBe(0);
  });
});
