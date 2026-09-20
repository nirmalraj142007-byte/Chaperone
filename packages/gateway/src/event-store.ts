/**
 * DynamoDB-backed `EventStore` for `StreamableHTTPServerTransport`'s
 * resumable-SSE support. The interface, read directly from
 * @modelcontextprotocol/sdk 1.30.0's dist/esm/server/webStandardStreamableHttp.d.ts
 * (re-exported by server/streamableHttp.js, which session.ts's transport
 * comes from) rather than assumed, is:
 *
 *   type StreamId = string;
 *   type EventId = string;
 *   interface EventStore {
 *     storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;
 *     getStreamIdForEventId?(eventId: EventId): Promise<StreamId | undefined>;
 *     replayEventsAfter(lastEventId: EventId, { send }: {
 *       send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
 *     }): Promise<StreamId>;
 *   }
 *
 * `getStreamIdForEventId` is optional and deliberately not implemented here:
 * if it were, the transport's own `replayEvents()` (webStandardStreamableHttp.js)
 * would short-circuit a malformed `Last-Event-ID` into its own 400 "Invalid
 * event ID format" response *before* ever calling `replayEventsAfter` —
 * which is a different, and stricter, behaviour than "log it and start a
 * fresh stream". Omitting it routes every `Last-Event-ID` (well-formed or
 * not) through `replayEventsAfter` below, which is where that fallback is
 * implemented.
 *
 * Encodes each event ID as `{streamId}:{seq}`, where `streamId` is minted
 * by the transport itself (`crypto.randomUUID()` per request, or the fixed
 * string `_GET_stream` for the session's standalone GET stream — verified
 * against the same source) and `seq` is a per-stream monotonic integer
 * minted by @chaperone/ledger's `nextSseSeq` — a single DynamoDB
 * `UpdateItem ADD`, never a read followed by a write.
 *
 * One instance is built per session (session.ts), closing over that
 * session's ID, matching the `sse-event` table's partition key
 * `SESSION#{sessionId}#STREAM#{streamId}` — so `replayEventsAfter` can
 * never be pointed at a different session's stream by construction.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, EventId, StreamId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import * as ledger from "@chaperone/ledger";
import { childLogger } from "@chaperone/logger";
import { eventStoreWritesTotal } from "./metrics.js";

const log = childLogger({ component: "gateway-event-store" });
const SEPARATOR = ":";

function makeEventId(streamId: StreamId, seq: number): EventId {
  return `${streamId}${SEPARATOR}${seq}`;
}

/** `undefined` for anything that isn't exactly `{non-empty streamId}:{positive integer}`. */
function parseEventId(eventId: EventId): { streamId: StreamId; seq: number } | undefined {
  const idx = eventId.lastIndexOf(SEPARATOR);
  if (idx <= 0 || idx === eventId.length - 1) {
    return undefined;
  }
  const streamId = eventId.slice(0, idx);
  const seqPart = eventId.slice(idx + 1);
  if (!/^\d+$/.test(seqPart)) {
    return undefined;
  }
  const seq = Number(seqPart);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    return undefined;
  }
  return { streamId, seq };
}

export function createSessionEventStore(sessionId: string): EventStore {
  return {
    async storeEvent(streamId, message) {
      // Counted, then rethrown unchanged. The transport owns what a failed
      // store means for the stream; this only records that the event was
      // not persisted, which is the same as saying it can never be
      // replayed after a reconnect — the one number that says whether the
      // resumability claim is actually holding in production.
      try {
        const seq = await ledger.nextSseSeq(sessionId, streamId);
        const eventId = makeEventId(streamId, seq);
        await ledger.putSseEvent({
          sessionId,
          streamId,
          seq,
          eventId,
          message: JSON.stringify(message),
          ts: new Date().toISOString(),
          ttl: ledger.sseEventTtl(),
        });
        eventStoreWritesTotal.inc({ outcome: "ok" });
        return eventId;
      } catch (error) {
        eventStoreWritesTotal.inc({ outcome: "failed" });
        throw error;
      }
    },

    async replayEventsAfter(lastEventId, { send }) {
      const parsed = parseEventId(lastEventId);
      if (parsed === undefined) {
        log.warn({ sessionId, lastEventId }, "malformed Last-Event-ID; starting a fresh stream instead of replaying");
        return randomUUID();
      }

      const { streamId, seq } = parsed;
      let events;
      try {
        events = await ledger.listSseEventsSince(sessionId, streamId, seq);
      } catch (error) {
        log.error({ error, sessionId, streamId, seq }, "failed to load replay events; starting a fresh stream");
        return randomUUID();
      }

      // Ascending, and scoped to exactly this stream's partition key — never
      // another stream in the same session, by construction of the query.
      for (const event of events) {
        await send(event.eventId, JSON.parse(event.message) as JSONRPCMessage);
      }
      return streamId;
    },
  };
}
