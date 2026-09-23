import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NonLoopbackConnectionError, installLoopbackGuard, isLoopbackHost } from "../demo/loopback-guard.js";

let uninstall: () => void;

beforeEach(() => {
  uninstall = installLoopbackGuard();
});

afterEach(() => {
  uninstall();
});

function connectError(options: net.NetConnectOpts): Promise<Error | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(options);
    socket.once("error", (error) => resolve(error));
    socket.once("connect", () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])("%s is this machine", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["example.com", "1.1.1.1", "192.168.1.10", "10.0.0.5", "ddb", "localhost.example.com"])("%s is not", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("installLoopbackGuard", () => {
  it("refuses a connection to a public name before any packet is sent", async () => {
    const error = await connectError({ host: "example.com", port: 443 });
    expect(error).toBeInstanceOf(NonLoopbackConnectionError);
    expect((error as NonLoopbackConnectionError).host).toBe("example.com");
  });

  it("refuses a public address given as a bare number of arguments, too", async () => {
    const error = await new Promise<Error | undefined>((resolve) => {
      const socket = net.connect(443, "1.1.1.1");
      socket.once("error", resolve);
    });
    expect(error).toBeInstanceOf(NonLoopbackConnectionError);
  });

  it("refuses fetch to a public URL", async () => {
    await expect(fetch("https://example.com/", { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  });

  it("lets a loopback connection through", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("ok");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("removes itself: uninstall puts the original connect back", () => {
    uninstall();
    const original = net.Socket.prototype.connect;
    const again = installLoopbackGuard();
    expect(net.Socket.prototype.connect).not.toBe(original);
    again();
    expect(net.Socket.prototype.connect).toBe(original);
    uninstall = installLoopbackGuard();
  });
});
