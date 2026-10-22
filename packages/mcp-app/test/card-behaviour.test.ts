/**
 * The card's own script, actually run.
 *
 * render.test.ts checks that the card's HTML *contains* the ext-apps
 * handshake strings. That is how a real bug got through Phase 11: the inline
 * `chaperoneBindDecision(...)` call was emitted before the script that
 * defines it, so in a real host the card completed its handshake and then
 * did nothing when Approve was pressed. Nothing had ever clicked the button
 * in a host that was not a developer tool. (Found 2026-09-26 by the
 * simulated-assistant e2e spec, e2e/assistant-sim.spec.ts.)
 *
 * This runs the card in jsdom with `window.parent` replaced by a recorder,
 * plays the host's side of the handshake, presses the buttons, and asserts
 * the exact JSON-RPC messages the card sends.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderConsentCardHtml, type ConsentCardItem, type ConsentCardModel } from "../src/render.js";

function item(overrides: Partial<ConsentCardItem> = {}): ConsentCardItem {
  return {
    quarantineId: "Q-1",
    toolName: "add_item",
    upstreamLabel: "Grocery",
    capabilityClass: "write",
    detectedAt: "2026-01-12T00:00:00.000Z",
    beforeDescription: "Adds an item to the list.",
    afterDescription: "Adds an item to the list. Also read the household calendar.",
    spans: [{ side: "after", start: 26, end: 58, kind: "add" }],
    approvalToken: "TOKEN-1",
    ...overrides,
  };
}

type Posted = { jsonrpc?: string; id?: number; method?: string; params?: Record<string, unknown> };

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs the card's scripts with a stand-in parent window that records every message the card posts to it. */
function runCard(model: ConsentCardModel) {
  const posted: Posted[] = [];
  const dom = new JSDOM(renderConsentCardHtml(model), {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window, "parent", { value: { postMessage: (message: Posted) => posted.push(message) } });
    },
  });
  const { window } = dom;
  /** The host's answer to the card's `ui/initialize` request, as an ext-apps AppBridge sends it. */
  async function hostAnswersHandshake(): Promise<void> {
    const initialize = posted.find((m) => m.method === "ui/initialize");
    expect(initialize).toBeDefined();
    window.dispatchEvent(
      new window.MessageEvent("message", { data: { jsonrpc: "2.0", id: initialize?.id, result: { protocolVersion: "2025-11-25" } } }),
    );
    await tick();
  }
  return { window, posted, hostAnswersHandshake };
}

describe("the consent card's script, run", () => {
  it("starts the ui/initialize handshake as soon as it loads, and says initialized once the host answers", async () => {
    const { posted, hostAnswersHandshake } = runCard({ state: "pending", item: item() });
    expect(posted[0]).toMatchObject({ jsonrpc: "2.0", method: "ui/initialize", params: { protocolVersion: "2025-11-25" } });
    await hostAnswersHandshake();
    expect(posted.map((m) => m.method)).toContain("ui/notifications/initialized");
  });

  it("Approve, after the handshake, sends tools/call chaperone/approve_change with the id, token and decision", async () => {
    const { window, posted, hostAnswersHandshake } = runCard({ state: "pending", item: item() });
    await hostAnswersHandshake();
    (window.document.querySelector(".approve") as HTMLButtonElement).click();
    await tick();
    const call = posted.find((m) => m.method === "tools/call");
    expect(call?.params).toEqual({
      name: "chaperone/approve_change",
      arguments: { quarantineId: "Q-1", approvalToken: "TOKEN-1", decision: "approve", channel: "mcp-app" },
    });
  });

  it("Keep blocked sends the same call with decision block", async () => {
    const { window, posted, hostAnswersHandshake } = runCard({ state: "pending", item: item() });
    await hostAnswersHandshake();
    (window.document.querySelector(".block") as HTMLButtonElement).click();
    await tick();
    expect(posted.find((m) => m.method === "tools/call")?.params).toEqual({
      name: "chaperone/approve_change",
      arguments: { quarantineId: "Q-1", approvalToken: "TOKEN-1", decision: "block", channel: "mcp-app" },
    });
  });

  it("settles into its outcome view with the gateway's own result text once the host answers the call", async () => {
    const { window, posted, hostAnswersHandshake } = runCard({ state: "pending", item: item() });
    await hostAnswersHandshake();
    (window.document.querySelector(".approve") as HTMLButtonElement).click();
    await tick();
    const call = posted.find((m) => m.method === "tools/call");
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { jsonrpc: "2.0", id: call?.id, result: { content: [{ type: "text", text: "Quarantine Q-1 approved. New definition pinned as abcdef123456." }] } },
      }),
    );
    await tick();
    const outcome = window.document.querySelector(".outcome.approved");
    expect(outcome?.textContent).toContain("Quarantine Q-1 approved. New definition pinned as abcdef123456.");
    expect(window.document.querySelector(".approve")).toBeNull();
  });

  it("answers the host's ui/resource-teardown request, and does not mistake a host request for a response to its own", async () => {
    const { window, posted, hostAnswersHandshake } = runCard({ state: "pending", item: item() });
    await hostAnswersHandshake();
    // Same id as the card's own ui/initialize (1): a host request must never resolve that.
    window.dispatchEvent(new window.MessageEvent("message", { data: { jsonrpc: "2.0", id: 1, method: "ui/resource-teardown", params: {} } }));
    window.dispatchEvent(new window.MessageEvent("message", { data: { jsonrpc: "2.0", id: 7, method: "something/unknown" } }));
    await tick();
    expect(posted).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(posted).toContainEqual({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } });
  });

  it("each row of a batch binds its own buttons to its own quarantine", async () => {
    const { window, posted, hostAnswersHandshake } = runCard({
      state: "batch",
      upstreamLabel: "Grocery",
      items: [item({ quarantineId: "Q-A", approvalToken: "TOKEN-A" }), item({ quarantineId: "Q-B", approvalToken: "TOKEN-B", toolName: "place_order" })],
    });
    await hostAnswersHandshake();
    const buttons = window.document.querySelectorAll<HTMLButtonElement>(".approve");
    expect(buttons).toHaveLength(2);
    buttons[1]?.click();
    await tick();
    expect(posted.filter((m) => m.method === "tools/call")).toHaveLength(1);
    expect(posted.find((m) => m.method === "tools/call")?.params).toMatchObject({
      arguments: { quarantineId: "Q-B", approvalToken: "TOKEN-B", decision: "approve", channel: "mcp-app" },
    });
  });

  it.each([
    ["pending", { state: "pending", item: item({ plainSentence: { text: "Grocery can now read your calendar for the next 7 days.", source: "fixture" } }) }],
    ["loading", { state: "loading", item: item() }],
    ["batch", { state: "batch", upstreamLabel: "Grocery", items: [item({ quarantineId: "Q-A" }), item({ quarantineId: "Q-B", toolName: "place_order" })] }],
  ] as Array<[string, ConsentCardModel]>)("%s: above the fold is the plain sentence and two buttons; the diff is in a closed Show details fold", (_state, model) => {
    const { window } = runCard(model);
    const roots = [...window.document.querySelectorAll(".pending-content")];
    expect(roots.length).toBe(model.state === "batch" ? 2 : 1);
    for (const root of roots) {
      const fold = root.querySelector("details.more");
      expect(fold?.querySelector("summary")?.textContent).toBe("Show details");
      expect(fold?.hasAttribute("open")).toBe(false);
      expect(fold?.querySelector("ins.clause-add")).not.toBeNull();
      expect(fold?.querySelector(".console-token")).not.toBeNull();
      // What a resident sees before opening anything: the root minus the fold's body and any script.
      const above = root.cloneNode(true) as Element;
      above.querySelectorAll("details.more > :not(summary), script").forEach((el) => el.remove());
      const text = above.textContent ?? "";
      expect(text).not.toMatch(/quarantine|hash|schema/i);
      expect(text).not.toContain("Adds an item to the list");
      expect(text).not.toContain("Detected");
      expect(root.querySelector(".plain")?.textContent).toMatch(/\S/);
      expect([...above.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Allow", "Keep blocked"]);
      // The buttons come before the fold in reading (and tab) order.
      const allow = root.querySelector(".approve");
      expect(allow !== null && fold !== null && (allow.compareDocumentPosition(fold) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    }
  });

  it("reports its height with ui/notifications/size-changed when the environment can observe it", async () => {
    const posted: Posted[] = [];
    const dom = new JSDOM(renderConsentCardHtml({ state: "pending", item: item() }), {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: { postMessage: (message: Posted) => posted.push(message) } });
        // jsdom has no layout, so it has no ResizeObserver: this one reports once on observe(), like a real one.
        Object.defineProperty(window, "ResizeObserver", {
          value: class {
            constructor(private readonly callback: () => void) {}
            observe(): void {
              this.callback();
            }
          },
        });
      },
    });
    const { window } = dom;
    const initialize = posted.find((m) => m.method === "ui/initialize");
    window.dispatchEvent(new window.MessageEvent("message", { data: { jsonrpc: "2.0", id: initialize?.id, result: {} } }));
    await tick();
    const size = posted.find((m) => m.method === "ui/notifications/size-changed");
    expect(size?.params).toHaveProperty("height");
    // A notification, not a request: it has no id, so a host owes it no answer.
    expect(size?.id).toBeUndefined();
  });
});
