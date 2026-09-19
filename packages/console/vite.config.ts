import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The browser never talks to DynamoDB or holds AWS credentials: /api (read
// only) and /mcp (the token-checked approve path) are both proxied to the
// gateway. Same-origin from the browser's point of view, so no CORS; the
// gateway's own Origin allowlist ("http://localhost:*" by default) still
// applies to the forwarded Origin header.
const gateway = process.env["CHAPERONE_GATEWAY_URL"] ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": gateway,
      "/mcp": gateway,
    },
  },
});
