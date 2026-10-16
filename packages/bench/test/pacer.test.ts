import { describe, expect, it } from "vitest";
import { BenchError } from "@chaperone/errors";
import { createPacer } from "../src/latency.js";

/**
 * A frozen clock: callers that arrive together all see the same instant, as
 * they do in real time between two awaits. `sleep` only records the wait.
 */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    now: () => 1_000,
    sleep: async (ms) => {
      slept.push(ms);
    },
    slept,
  };
}

describe("createPacer", () => {
  it("starts calls no faster than the rate, however many callers share it", async () => {
    const clock = fakeClock();
    const pace = createPacer(8, clock.now, clock.sleep);
    // Four sessions asking at once: the first goes now, the rest queue 125 ms apart.
    await Promise.all([pace(), pace(), pace(), pace()]);
    expect(clock.slept).toEqual([125, 250, 375]);
  });

  it("does not sleep when the caller is already behind the schedule", async () => {
    let t = 0;
    const slept: number[] = [];
    const pace = createPacer(10, () => t, async (ms) => void slept.push(ms));
    await pace();
    t = 500; // the call took longer than one interval
    await pace();
    expect(slept).toEqual([]);
  });

  it("rejects a rate that is not a positive number", () => {
    expect(() => createPacer(0)).toThrow(BenchError);
    expect(() => createPacer(Number.NaN)).toThrow(BenchError);
    expect(() => createPacer(Number.POSITIVE_INFINITY)).toThrow(BenchError);
  });
});
