/**
 * Makes "the demo scripts touch nothing outside this machine" true of the
 * script process itself, not just of where it happens to point.
 *
 * Every TCP connection Node makes, from `fetch`, the MCP SDK, the AWS SDK,
 * TLS included, goes through `net.Socket.prototype.connect`. This wraps it:
 * a connection to anything but loopback is destroyed with an error before
 * a packet is sent. Unix-domain sockets and named pipes are local by
 * definition and pass.
 *
 * What this does not cover, and does not claim to: child processes (the
 * `docker` CLI, `vite build`), which are separate programs; the browser,
 * which `pnpm demo:verify` polices with its own request filter; and the
 * containers, which docker/compose.offline.yml cuts off at the network.
 */
import net from "node:net";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Pulls the host out of the many shapes `socket.connect` accepts. Returns undefined for a local (unix/pipe) target. */
function targetHost(args: unknown[]): string | undefined {
  // `net.connect()` normalises its arguments and hands `socket.connect` a single `[options, callback]` array.
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: unknown; host?: unknown };
    if (typeof options.path === "string") return undefined;
    return typeof options.host === "string" ? options.host : "localhost";
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  return undefined;
}

export class NonLoopbackConnectionError extends Error {
  constructor(readonly host: string) {
    super(`blocked: this demo script tried to connect to "${host}", which is not this machine`);
    this.name = "NonLoopbackConnectionError";
  }
}

/** Installs the guard; returns a function that removes it. Safe to call more than once. */
export function installLoopbackGuard(): () => void {
  const original = net.Socket.prototype.connect;
  const guarded = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const host = targetHost(args);
    if (host !== undefined && !isLoopbackHost(host)) {
      // On the next tick, so the caller has attached its 'error' listener by the time the error is emitted.
      process.nextTick(() => this.destroy(new NonLoopbackConnectionError(host)));
      return this;
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  };
  net.Socket.prototype.connect = guarded as typeof net.Socket.prototype.connect;
  return () => {
    net.Socket.prototype.connect = original;
  };
}
