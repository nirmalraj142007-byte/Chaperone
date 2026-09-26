/**
 * Hosts Chaperone's consent card as a real MCP App.
 *
 * The card speaks `@modelcontextprotocol/ext-apps` 1.7.5: it performs the
 * `ui/initialize` JSON-RPC handshake over `postMessage` and then sends a
 * `tools/call` request for `chaperone/approve_change` when the resident
 * presses a button (packages/mcp-app/src/render.ts). This component is the
 * other end of that wire, built on the package's own host-side class,
 * `AppBridge`, plus its `PostMessageTransport`:
 *
 *   card (sandboxed iframe) <-postMessage-> AppBridge <-> `decide` -> gateway /mcp
 *
 * Host responsibilities, and what this does about each:
 *  - Isolation. The card runs in `<iframe sandbox="allow-scripts" srcdoc>`:
 *    an opaque origin, so it cannot touch this page. A CSP added to the
 *    document (cardHtml.ts) also stops it making any network request.
 *  - Answering the handshake. `AppBridge` does it; `bridge.connect()` is
 *    awaited *before* the frame gets its content, so the card's very first
 *    message cannot arrive before anyone is listening.
 *  - Proxying tool calls. Constructed with a `null` client so nothing is
 *    forwarded automatically; `oncalltool` is the only path, and it only
 *    ever forwards `chaperone/approve_change` with the three fields that
 *    tool takes. A card cannot use this host to call any other tool.
 *  - Sizing. The card reports its height with the standard
 *    `ui/notifications/size-changed` notification; the frame follows it.
 *  - Teardown. When the card asks to be closed (after an approval) the host
 *    sends `ui/resource-teardown`, waits for the answer, then unmounts it.
 *
 * Fallback, stated plainly to the resident when it happens: if the card
 * never completes the handshake within HANDSHAKE_TIMEOUT_MS, or the gateway
 * sent no HTML at all, the text card is shown instead, with the same two
 * decisions as ordinary buttons. Nothing about the decision changes; only
 * how it is drawn.
 */
import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "../rules";
import { withCsp } from "../cardHtml";
import { parseTextCardAction, type HeldCard } from "../outcome";

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** `?card=text` shows the text card even when the interactive one would work: for filming the floor, and for testing it. */
function textCardRequested(): boolean {
  return new URLSearchParams(window.location.search).get("card") === "text";
}
const TEARDOWN_TIMEOUT_MS = 1_500;
const INITIAL_HEIGHT = 380;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 900;

export type Decision = "approve" | "block";

export interface DecisionRequest {
  quarantineId: string;
  approvalToken: string;
  decision: Decision;
}

/** Runs the decision through the gateway. Resolves with the tool's own result; never throws for an isError result. */
export type Decide = (request: DecisionRequest) => Promise<CallToolResult>;

type Phase = "starting" | "live" | "text" | "closed";

function isDecision(value: unknown): value is Decision {
  return value === "approve" || value === "block";
}

/** The card's tool call, checked down to its three fields. Anything else is not forwarded. */
function parseDecisionRequest(name: string, args: Record<string, unknown> | undefined): DecisionRequest {
  if (name !== TOOLS.approveChange) {
    throw new Error(`this host only forwards ${TOOLS.approveChange} for a consent card, not "${name}"`);
  }
  const { quarantineId, approvalToken, decision } = args ?? {};
  if (typeof quarantineId !== "string" || typeof approvalToken !== "string" || !isDecision(decision)) {
    throw new Error("malformed approve_change arguments");
  }
  return { quarantineId, approvalToken, decision };
}

function resultText(result: CallToolResult): string {
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export function ConsentCard({ card, decide }: { card: HeldCard; decide: Decide }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<Phase>(card.html === undefined || textCardRequested() ? "text" : "starting");
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [decided, setDecided] = useState<Decision | undefined>(undefined);
  const decideRef = useRef(decide);
  decideRef.current = decide;

  useEffect(() => {
    const html = card.html;
    const frameWindow = iframeRef.current?.contentWindow;
    if (html === undefined || frameWindow === null || frameWindow === undefined) return;
    const iframe = iframeRef.current;
    if (iframe === null) return;

    let disposed = false;
    let live = false;
    const bridge = new AppBridge(
      null,
      { name: "simulated-household-assistant", version: "0.0.0" },
      { serverTools: {} },
      { hostContext: { theme: "light", displayMode: "inline", platform: "web", locale: navigator.language } },
    );

    bridge.addEventListener("initialized", () => {
      live = true;
      if (!disposed) setPhase("live");
    });
    bridge.addEventListener("sizechange", ({ height: reported }) => {
      if (!disposed && reported !== undefined) {
        setHeight(Math.min(Math.max(Math.ceil(reported), MIN_HEIGHT), MAX_HEIGHT));
      }
    });
    bridge.addEventListener("requestteardown", () => {
      // The spec has the host wait for the view's answer before unmounting it,
      // and a view that never answers must not keep the card on screen forever.
      void Promise.race([
        bridge.teardownResource({}),
        new Promise((resolve) => window.setTimeout(resolve, TEARDOWN_TIMEOUT_MS)),
      ])
        .catch(() => undefined)
        .finally(() => {
          if (!disposed) setPhase("closed");
        });
    });
    bridge.oncalltool = async (params) => {
      const request = parseDecisionRequest(params.name, params.arguments);
      const result = await decideRef.current(request);
      if (!disposed && result.isError !== true) setDecided(request.decision);
      return result;
    };

    void bridge.connect(new PostMessageTransport(frameWindow, frameWindow)).then(() => {
      if (!disposed) iframe.srcdoc = withCsp(html);
    });
    const timer = window.setTimeout(() => {
      if (!live && !disposed) setPhase("text");
    }, HANDSHAKE_TIMEOUT_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void bridge.close();
    };
  }, [card.html]);

  if (phase === "closed") {
    return (
      <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted" data-testid="card-closed">
        Review card closed.{" "}
        {decided === "approve" ? "You approved the change." : decided === "block" ? "You kept it blocked." : "No decision was recorded."}
      </p>
    );
  }
  if (phase === "text") {
    return (
      <TextCard
        card={card}
        decide={decide}
        fallbackReason={card.html === undefined ? "gateway-sent-no-html" : textCardRequested() ? "requested" : "handshake-timeout"}
      />
    );
  }
  return (
    <div data-testid="consent-card" data-phase={phase}>
      <iframe
        ref={iframeRef}
        title="Chaperone review card: the tool's old and new description, with Approve and Keep blocked"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="block w-full rounded-lg border border-line bg-surface"
        style={{ height }}
      />
      <p className="mt-2 text-xs text-muted">
        Interactive card, hosted here as an MCP App (<span className="font-mono">ui/initialize</span> handshake
        {phase === "live" ? " completed" : " in progress"}).
      </p>
    </div>
  );
}

const FALLBACK_TEXT = {
  "gateway-sent-no-html": "The gateway sent only the text version of this card, so it is shown as text.",
  "handshake-timeout": "The interactive card did not start in this browser within 10 seconds, so it is shown as text.",
  requested: "You asked for the text version of this card (?card=text), so it is shown as text.",
} as const;

/** The text card and the same two decisions, drawn by this page instead of by the card. */
function TextCard({
  card,
  decide,
  fallbackReason,
}: {
  card: HeldCard;
  decide: Decide;
  fallbackReason: "gateway-sent-no-html" | "handshake-timeout" | "requested";
}) {
  const [outcome, setOutcome] = useState<{ decision: Decision; ok: boolean; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const action = card.text === undefined ? undefined : parseTextCardAction(card.text);

  async function run(decision: Decision): Promise<void> {
    if (action === undefined) return;
    setBusy(true);
    try {
      const result = await decide({ ...action, decision });
      setOutcome({ decision, ok: result.isError !== true, text: resultText(result) });
    } catch (error) {
      setOutcome({ decision, ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4" data-testid="consent-card-text" aria-label="Chaperone review card, text version">
      <p className="mb-3 rounded bg-held-wash px-3 py-2 text-sm text-held">
        {FALLBACK_TEXT[fallbackReason]}{" "}
        The decision works the same way.
      </p>
      {card.text === undefined ? (
        <p className="text-sm">No card was included with this refusal.</p>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">{card.text.replace(/approvalToken=\S+/g, "approvalToken=(one-time token, used by the buttons below)")}</pre>
      )}
      {outcome === undefined ? (
        <div className="mt-4 flex gap-3">
          <button type="button" className="btn btn-primary" disabled={busy || action === undefined} onClick={() => void run("approve")}>
            Approve
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy || action === undefined} onClick={() => void run("block")}>
            Keep blocked
          </button>
        </div>
      ) : (
        <p className={`mt-4 text-sm font-medium ${outcome.ok ? "text-ok" : "text-held"}`} role="status">
          {outcome.ok ? (outcome.decision === "approve" ? "Approved. " : "Kept blocked. ") : "Not recorded. "}
          {outcome.text}
        </p>
      )}
    </section>
  );
}
