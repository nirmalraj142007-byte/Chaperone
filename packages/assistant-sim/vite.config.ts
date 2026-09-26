import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Same shape as packages/console: the browser only ever talks to its own
// origin, and /mcp is proxied to the gateway. Nothing here is a shortcut
// around the gateway; the proxy forwards the MCP Streamable HTTP requests
// (initialize, tools/list, tools/call, the SSE stream, DELETE) untouched.
// The gateway's Origin allowlist ("http://localhost:*" by default) still
// applies to the forwarded Origin header.
const gateway = process.env["CHAPERONE_GATEWAY_URL"] ?? "http://localhost:3000";

const proxy = { "/mcp": gateway };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true, proxy },
  // `vite preview` serves the production build (what `pnpm demo:assistant`
  // and the Playwright specs use), so it needs the same proxy table.
  preview: { port: 5174, strictPort: true, proxy },
});
