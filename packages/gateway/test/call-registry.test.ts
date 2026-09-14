import { describe, expect, it, vi } from "vitest";
import { createCallRegistry } from "../src/call-registry.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("call-registry", () => {
  it("invokes run exactly once for two concurrent calls with the same request ID", async () => {
    const registry = createCallRegistry();
    const run = vi.fn(async () => {
      const { promise, resolve } = deferred<string>();
      setTimeout(() => resolve("upstream result"), 10);
      return promise;
    });

    const [a, b] = await Promise.all([registry.runOnce(1, run), registry.runOnce(1, run)]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(a).toBe("upstream result");
    expect(b).toBe("upstream result");
  });

  it("attaches a late duplicate — arriving after the original call already settled — to the cached result, not a fresh invocation", async () => {
    const registry = createCallRegistry();
    const run = vi.fn(async () => "upstream result");

    await registry.runOnce("req-1", run);
    const second = await registry.runOnce("req-1", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toBe("upstream result");
  });

  it("still calls run once even when a genuinely in-flight (unresolved) call is reattached to mid-flight", async () => {
    const registry = createCallRegistry();
    const { promise, resolve } = deferred<string>();
    const run = vi.fn(() => promise);

    const first = registry.runOnce("req-1", run);
    // A "reconnect" attaching to the still-running original call.
    const second = registry.runOnce("req-1", run);
    resolve("done");

    await expect(first).resolves.toBe("done");
    await expect(second).resolves.toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("invokes run again for a different request ID", async () => {
    const registry = createCallRegistry();
    const run = vi.fn(async () => "result");

    await registry.runOnce("req-1", run);
    await registry.runOnce("req-2", run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("caches a rejection too — a duplicate never gets a second attempt at the upstream", async () => {
    const registry = createCallRegistry();
    const run = vi.fn(async () => {
      throw new Error("upstream failed");
    });

    await expect(registry.runOnce("req-1", run)).rejects.toThrow("upstream failed");
    await expect(registry.runOnce("req-1", run)).rejects.toThrow("upstream failed");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
