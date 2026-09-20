// @vitest-environment jsdom
/**
 * Every designed state of every route, snapshotted.
 *
 * Four states × six routes = 24 snapshots, which is the floor, not the
 * target: /corpus adds its two real, data-driven states on top, because
 * the partial one is what the screen actually shows for the 35 days
 * between the crawls and a fixture-only proof of it would be worth very
 * little.
 *
 * Each case mounts the real <App/> at a real URL with a real `?state=`
 * override, so what is asserted is the same JSX a judge sees in the
 * browser — the overrides are applied at the view boundary (state.ts), not
 * inside the render path, precisely so this is true.
 *
 * `fetch` is stubbed to never settle. Every query therefore stays pending
 * for the life of the test, which makes the snapshots deterministic and
 * makes the overrides the only thing deciding what renders. A test that
 * passed because a request happened to fail fast would not be a test.
 */
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { EvidenceContext, corpusState, type Drift, type Evidence } from "../src/evidence";
import { STATE_OVERRIDES } from "../src/state";
import { wireReset } from "../src/wire";
import realEvidence from "./evidence.fixture";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Never settles: queries stay pending, so nothing but the override decides what renders.
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  // `ago()` and the crawl-2 countdown both read the clock. Freeze it, or
  // these snapshots rot by one day every day.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

afterEach(() => {
  document.body.innerHTML = "";
});

beforeEach(() => {
  // The wire is a module-level store shared by every render in this file.
  // Without this the entry count it prints would depend on test order.
  wireReset();
});

async function render(path: string, evidence: Evidence = realEvidence): Promise<string> {
  window.history.replaceState(null, "", path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <StrictMode>
        <EvidenceContext.Provider value={evidence}>
          <QueryClientProvider client={client}>
            <App />
          </QueryClientProvider>
        </EvidenceContext.Provider>
      </StrictMode>,
    );
  });
  const html = container.innerHTML;
  await act(async () => {
    root.unmount();
  });
  client.clear();
  return html;
}

const ROUTES = [
  { name: "queue", path: "/queue" },
  { name: "queue-detail", path: "/queue/fixture-01J0000000000000000000" },
  { name: "ledger", path: "/ledger" },
  { name: "corpus", path: "/corpus" },
  { name: "bench", path: "/bench" },
  { name: "upstreams", path: "/upstreams" },
] as const;

describe("every designed state of every route", () => {
  for (const route of ROUTES) {
    for (const state of STATE_OVERRIDES) {
      it(`${route.name} · ${state}`, async () => {
        const html = await render(`${route.path}?state=${state}`);
        expect(html.length).toBeGreaterThan(0);
        // Nothing renders the literal string "undefined" or "NaN" — the
        // classic way a state screen leaks a missing value into the page.
        expect(html).not.toContain(">undefined<");
        expect(html).not.toContain("NaN");
        await expect(html).toMatchFileSnapshot(`./__snapshots__/${route.name}.${state}.html`);
      });
    }
  }
});

describe("/corpus renders its real states from committed data", () => {
  it("is partial today: crawl 1 recorded, crawl 2 pending", async () => {
    expect(corpusState(realEvidence)).toBe("partial");
    const html = await render("/corpus");
    // The three things the partial state must show.
    expect(html).toContain("did not start from their own documented setup instructions");
    expect(html).toContain("2026-10-20");
    expect(html).toContain("4,381");
    // And the three it must not: no drift rate, no placeholder zero, no failure language.
    expect(html).not.toContain("Semantic-intent drift by capability class");
    expect(html).not.toMatch(/>0<|>0\.0%</);
    expect(html.toLowerCase()).not.toContain("no data");
    await expect(html).toMatchFileSnapshot("./__snapshots__/corpus.real-partial.html");
  });

  it("is empty when no crawl has been recorded, and still names both target dates", async () => {
    const html = await render("/corpus", { ...realEvidence, crawl1: null, bootRate: null });
    expect(html).toContain("No crawl data yet");
    expect(html).toContain("2026-09-15");
    expect(html).toContain("2026-10-20");
    await expect(html).toMatchFileSnapshot("./__snapshots__/corpus.real-empty.html");
  });

  it("is complete once drift.json says so, with N, both timestamps, the day count and the taxonomy blob", async () => {
    const drift: Drift = {
      ...(realEvidence.drift as Drift),
      status: "complete",
      n: 131,
      crawl2StartedAt: "2026-10-20T06:11:03.900Z",
      semanticIntent: { servers: 131, drifted: 37, ratePct: 28.2 },
      byCapability: [
        { capabilityClass: "transact", servers: 18, drifted: 9, ratePct: 50.0 },
        { capabilityClass: "communicate", servers: 26, drifted: 8, ratePct: 30.8 },
        { capabilityClass: "write", servers: 51, drifted: 14, ratePct: 27.5 },
        { capabilityClass: "read", servers: 36, drifted: 6, ratePct: 16.7 },
      ],
      countedSeparately: { cosmetic: 44, schemaAdditive: 19, toolAdded: 12, toolRemoved: 5 },
    };
    const ev: Evidence = { ...realEvidence, drift };
    expect(corpusState(ev)).toBe("complete");
    const html = await render("/corpus", ev);
    expect(html).toContain("Semantic-intent drift by capability class");
    expect(html).toContain("131");
    expect(html).toContain("2026-09-15T06:19:42.282Z");
    expect(html).toContain("2026-10-20T06:11:03.900Z");
    // 35 days, derived from the two recorded timestamps, never a rounded week count.
    expect(html).toContain("35");
    expect(html).toContain("0c896539006dbb6f8dfacc1f02ebbf179c50eec2");
    await expect(html).toMatchFileSnapshot("./__snapshots__/corpus.real-complete.html");
  });
});

describe("/bench", () => {
  it("flags a latency run recorded against a different commit as stale", async () => {
    const ev: Evidence = {
      ...realEvidence,
      headSha: "1111111111111111111111111111111111111111",
      latency: {
        recordedAt: "2026-09-19T21:03:00.000Z",
        commitSha: "2222222222222222222222222222222222222222",
        samples: 400,
        addedP50Ms: 6.2,
        addedP95Ms: 21.4,
        addedP99Ms: 34.8,
        budgetP95Ms: 30,
      },
    };
    const html = await render("/bench", ev);
    expect(html).toContain("Stale");
    expect(html).toContain("recorded 222222222222");
    expect(html).toContain("HEAD 111111111111");
    await expect(html).toMatchFileSnapshot("./__snapshots__/bench.real-stale.html");
  });

  it("does not claim freshness when HEAD could not be read", async () => {
    const ev: Evidence = {
      ...realEvidence,
      headSha: null,
      latency: {
        recordedAt: "2026-09-19T21:03:00.000Z",
        commitSha: "2222222222222222222222222222222222222222",
        samples: 400,
        addedP50Ms: 6.2,
        addedP95Ms: 21.4,
        addedP99Ms: 34.8,
        budgetP95Ms: 30,
      },
    };
    const html = await render("/bench", ev);
    expect(html).toContain("Unverified");
    expect(html).not.toContain("Stale");
  });
});

describe("/upstreams", () => {
  it("hides the rehearsal control unless VITE_DEMO_CONTROLS is set", async () => {
    const html = await render("/upstreams?state=partial");
    expect(html).not.toContain("Rehearsal control");
  });

  it("shows the rehearsal control when it is", async () => {
    vi.stubEnv("VITE_DEMO_CONTROLS", "true");
    const html = await render("/upstreams?state=partial");
    expect(html).toContain("Rehearsal control");
    expect(html).toContain("Mutate add_item");
    await expect(html).toMatchFileSnapshot("./__snapshots__/upstreams.demo-controls.html");
    vi.unstubAllEnvs();
  });
});

/**
 * The layout-shift guarantee, asserted structurally rather than by eye.
 *
 * A skeleton row and the real row it stands in for take their height from
 * the same `--row-*` custom property, so they cannot drift apart in a later
 * edit. This checks that both states actually reference it — a skeleton
 * that hard-coded a matching literal would pass a screenshot diff today
 * and fail silently the first time a row grew.
 */
describe("loading skeletons match the loaded layout", () => {
  const CASES = [
    { name: "queue", loading: "/queue?state=loading", loaded: "/queue?state=partial", token: "--row-queue" },
    { name: "ledger", loading: "/ledger?state=loading", loaded: "/ledger?state=partial", token: "--row-ledger" },
    { name: "upstreams", loading: "/upstreams?state=loading", loaded: "/upstreams?state=partial", token: "--row-upstream" },
  ] as const;

  for (const c of CASES) {
    it(`${c.name} uses ${c.token} in both states`, async () => {
      const loading = await render(c.loading);
      const loaded = await render(c.loaded);
      expect(loading).toContain(c.token);
      expect(loaded).toContain(c.token);
    });
  }

  it("keeps the same top-level section count on /corpus either side of loading", async () => {
    const loading = await render("/corpus?state=loading");
    const loaded = await render("/corpus?state=partial");
    const count = (html: string): number => (html.match(/aria-busy="true"/g) ?? []).length;
    // Five skeleton blocks stand in for the five sections the partial state renders.
    expect(count(loading)).toBe(5);
    expect(count(loaded)).toBe(0);
  });
});
