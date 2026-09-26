/**
 * The conversation: what the resident said, what the stand-in did with it,
 * and what came back over MCP. One hook so App.tsx stays about layout.
 *
 * The order of every turn is the same and is the whole point of the demo:
 *   1. rules.ts maps words to a tool call (no model)
 *   2. the call goes to the gateway over MCP (no shortcut)
 *   3. whatever the gateway answers is shown as it came, including the
 *      frozen refusal, byte for byte, and the card when there is one
 * Nothing in this file decides whether a tool may run.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GatewayConnection, GatewayError, type CallOutcome, type ConnectionInfo } from "./gateway";
import { classify, textBlocks, type Classified, type HeldCard } from "./outcome";
import { TOOLS, interpret, type RuleId } from "./rules";
import { speak } from "./speech";
import type { Decision, DecisionRequest } from "./components/ConsentCard";

export type Entry =
  | { id: number; role: "resident"; text: string }
  | { id: number; role: "assistant"; text: string }
  | { id: number; role: "tool"; tool: string; ok: boolean; text: string; ms: number }
  | { id: number; role: "held"; tool: string; refusal: string; card: HeldCard; ms: number }
  | { id: number; role: "notice"; tone: "info" | "error"; text: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One row of the "what just happened" table. */
export interface CallRecord {
  id: number;
  at: string;
  tool: string;
  /** The stand-in's rule that produced this call, or "card" when the consent card made it. */
  via: RuleId | "card";
  phrase: string;
  ms: number;
  requestId: string | undefined;
  result: "ran" | "held" | "error" | "approved" | "kept-blocked";
}

export type ConnectionState =
  | { state: "connecting" }
  | { state: "ready"; info: ConnectionInfo; tools: readonly string[]; connectMs: number }
  | { state: "unreachable"; message: string; kind: GatewayError["kind"] };

const GATEWAY_URL = new URL("/mcp", window.location.href);

function redactTokens(text: string): string {
  return text.replace(/approvalToken=\S+/g, "approvalToken=(hidden)");
}

function verdict(classified: Classified): CallRecord["result"] {
  return classified.kind === "ok" ? "ran" : classified.kind === "held" ? "held" : "error";
}

export function useAssistant(speechOn: boolean) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [connection, setConnection] = useState<ConnectionState>({ state: "connecting" });
  const [busy, setBusy] = useState(false);

  const gateway = useRef<GatewayConnection | undefined>(undefined);
  const nextId = useRef(1);
  const speechRef = useRef(speechOn);
  speechRef.current = speechOn;
  const busyRef = useRef(false);

  const push = useCallback((entry: DistributiveOmit<Entry, "id">) => {
    setEntries((current) => {
      // The gateway can say its list changed twice in a row (a quarantine, then its approval); once is enough.
      const last = current[current.length - 1];
      if (entry.role === "notice" && last?.role === "notice" && last.text === entry.text) return current;
      return [...current, { ...entry, id: nextId.current++ } as Entry];
    });
  }, []);

  const say = useCallback(
    (text: string) => {
      push({ role: "assistant", text });
      if (speechRef.current) speak(text);
    },
    [push],
  );

  const record = useCallback((entry: Omit<CallRecord, "id" | "at">) => {
    setCalls((current) => [...current, { ...entry, id: nextId.current++, at: new Date().toLocaleTimeString() }]);
  }, []);

  const connect = useCallback(() => {
    let cancelled = false;
    const conn = new GatewayConnection(GATEWAY_URL, {
      onListChanged: (tools) => {
        if (cancelled) return;
        setConnection((current) => (current.state === "ready" ? { ...current, info: conn.info, tools } : current));
        push({ role: "notice", tone: "info", text: "The gateway said its tool list changed (notifications/tools/list_changed). The assistant re-read it." });
      },
    });
    gateway.current = conn;
    setConnection({ state: "connecting" });
    const started = performance.now();
    conn.connect().then(
      () => {
        if (cancelled) {
          void conn.close();
          return;
        }
        setConnection({ state: "ready", info: conn.info, tools: conn.tools, connectMs: Math.round(performance.now() - started) });
      },
      (error: unknown) => {
        if (cancelled) return;
        setConnection({
          state: "unreachable",
          kind: error instanceof GatewayError ? error.kind : "unreachable",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      cancelled = true;
      void conn.close();
    };
  }, [push]);

  useEffect(() => connect(), [connect]);

  const retry = useCallback(() => {
    void gateway.current?.close();
    connect();
  }, [connect]);

  const refreshInfo = useCallback(() => {
    const conn = gateway.current;
    if (conn === undefined) return;
    setConnection((current) => (current.state === "ready" ? { ...current, info: conn.info, tools: conn.tools } : current));
  }, []);

  /** A GatewayError mid-conversation: say so once, in plain words, and stop treating the session as usable. */
  const connectionLost = useCallback(
    (error: unknown) => {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError("unreachable", String(error));
      setConnection({ state: "unreachable", kind: gatewayError.kind, message: gatewayError.message });
      push({
        role: "notice",
        tone: "error",
        text:
          gatewayError.kind === "session-lost"
            ? "The gateway no longer knows this session, so nothing was sent. Reconnect and ask again."
            : "The gateway did not answer, so nothing was sent. Reconnect and ask again.",
      });
    },
    [push],
  );

  const send = useCallback(
    async (utterance: string) => {
      const phrase = utterance.trim();
      const conn = gateway.current;
      if (phrase.length === 0 || busyRef.current || conn === undefined) return;
      busyRef.current = true;
      setBusy(true);
      push({ role: "resident", text: phrase });
      try {
        const step = interpret(phrase);
        if (step.kind === "reply") {
          say(step.text);
          return;
        }
        say(step.intro);
        let outcome: CallOutcome;
        try {
          outcome = await conn.callTool(step.tool, step.args);
        } catch (error) {
          connectionLost(error);
          return;
        }
        const classified = classify(outcome);
        record({ tool: step.tool, via: step.ruleId, phrase, ms: outcome.ms, requestId: outcome.requestId, result: verdict(classified) });
        if (classified.kind === "held") {
          say("The tool wasn't run. Chaperone held it and is showing you why:");
          push({ role: "held", tool: step.tool, refusal: classified.refusal, card: classified.card, ms: outcome.ms });
          if (speechRef.current) speak(classified.refusal);
        } else if (classified.kind === "error") {
          push({ role: "tool", tool: step.tool, ok: false, text: classified.text, ms: outcome.ms });
          say("That didn't go through. The tool's answer is above, word for word.");
        } else {
          push({ role: "tool", tool: step.tool, ok: true, text: redactTokens(classified.text), ms: outcome.ms });
          if (step.done !== undefined) say(step.done);
          if (step.tool === TOOLS.pendingChanges) refreshInfo();
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [connectionLost, push, record, refreshInfo, say],
  );

  /**
   * The consent card's decision, made through the same gateway session as
   * everything else. Called by the MCP App bridge (ConsentCard.tsx), which
   * has already checked this is `chaperone/approve_change` and nothing else.
   */
  const decide = useCallback(
    async (request: DecisionRequest): Promise<CallToolResult> => {
      const conn = gateway.current;
      if (conn === undefined) throw new Error("not connected to the gateway");
      let outcome: CallOutcome;
      try {
        outcome = await conn.callTool(TOOLS.approveChange, { ...request });
      } catch (error) {
        connectionLost(error);
        throw error;
      }
      const decision: Decision = request.decision;
      const ok = !outcome.isError;
      record({
        tool: TOOLS.approveChange,
        via: "card",
        phrase: decision === "approve" ? "Approve (card button)" : "Keep blocked (card button)",
        ms: outcome.ms,
        requestId: outcome.requestId,
        result: !ok ? "error" : decision === "approve" ? "approved" : "kept-blocked",
      });
      const text = textBlocks(outcome.blocks).join("\n");
      if (ok && decision === "approve") {
        try {
          await conn.refreshTools();
          refreshInfo();
        } catch {
          // The list_changed notification refreshes it too; a failure here is not the resident's problem.
        }
        say("Chaperone recorded your approval. Ask me again and I'll try it with the new wording.");
      } else if (ok) {
        say("Okay, it stays blocked. Nothing from that tool will run.");
      } else {
        say(`That decision wasn't recorded: ${text}`);
      }
      return { content: textBlocks(outcome.blocks).map((t) => ({ type: "text" as const, text: t })), isError: outcome.isError };
    },
    [connectionLost, record, refreshInfo, say],
  );

  return { entries, calls, connection, busy, send, retry, decide };
}
