/**
 * The `?state=` override rules. Pure, so the behaviour that decides what a
 * screenshot shows is pinned without rendering anything.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { applyOverride, overrideError, readOverride, viewOf, withOverride, type View } from "../src/state";

describe("readOverride", () => {
  it("accepts the four documented values", () => {
    for (const v of ["empty", "loading", "error", "partial"]) {
      expect(readOverride(`?state=${v}`)).toBe(v);
    }
  });

  it("ignores anything else, including a near miss", () => {
    expect(readOverride("")).toBeNull();
    expect(readOverride("?state=")).toBeNull();
    expect(readOverride("?state=Empty")).toBeNull();
    expect(readOverride("?state=broken")).toBeNull();
    expect(readOverride("?status=pending")).toBeNull();
  });

  it("reads it alongside another query parameter", () => {
    expect(readOverride("?status=pending&state=error")).toBe("error");
  });
});

describe("withOverride", () => {
  it("is a no-op with no override, so live URLs stay clean", () => {
    expect(withOverride("/queue?status=pending", null)).toBe("/queue?status=pending");
  });

  it("carries the override across an in-screen navigation", () => {
    expect(withOverride("/queue?status=pending", "empty")).toBe("/queue?status=pending&state=empty");
    expect(withOverride("/queue", "loading")).toBe("/queue?state=loading");
  });

  it("replaces an existing override rather than appending a second one", () => {
    expect(withOverride("/queue?state=error", "empty")).toBe("/queue?state=empty");
  });
});

describe("viewOf", () => {
  it("narrows a query result to the three branches a screen has", () => {
    expect(viewOf({ isPending: true, isError: false, error: null, data: undefined })).toEqual({ status: "loading" });
    expect(viewOf({ isPending: false, isError: false, error: null, data: 7 })).toEqual({ status: "ready", data: 7 });
    const e = new ApiError(503, "down");
    expect(viewOf({ isPending: false, isError: true, error: e, data: undefined })).toEqual({ status: "error", error: e });
  });

  it("treats settled-but-undefined as an error, not as ready with nothing", () => {
    expect(viewOf({ isPending: false, isError: false, error: null, data: undefined }).status).toBe("error");
  });
});

describe("applyOverride", () => {
  const live: View<number> = { status: "ready", data: 42 };
  const fixtures = { empty: 0, what: "the thing" };

  it("passes the live view through when there is no override", () => {
    expect(applyOverride(live, null, fixtures)).toBe(live);
  });

  it("forces each of the three simple states", () => {
    expect(applyOverride(live, "loading", fixtures)).toEqual({ status: "loading" });
    expect(applyOverride(live, "empty", fixtures)).toEqual({ status: "ready", data: 0 });
    const errored = applyOverride(live, "error", fixtures);
    expect(errored.status).toBe("error");
  });

  it("falls through to the live view for partial unless the screen supplies a fixture", () => {
    expect(applyOverride(live, "partial", fixtures)).toBe(live);
    expect(applyOverride(live, "partial", { ...fixtures, partial: 7 })).toEqual({ status: "ready", data: 7 });
  });

  it("overrides a loading view too, so a state is reachable before any response lands", () => {
    const loading: View<number> = { status: "loading" };
    expect(applyOverride(loading, "empty", fixtures)).toEqual({ status: "ready", data: 0 });
  });
});

describe("overrideError", () => {
  it("is a real 503 with the gateway's own storage-unavailable shape", () => {
    const e = overrideError("the ledger");
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(503);
    expect(e.message).toContain("the ledger");
    expect(e.body).toEqual({ error: "storage_unavailable" });
  });
});
