import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadEvidence } from "./evidence.load";

// The browser never talks to DynamoDB or holds AWS credentials: /api (read
// only) and /mcp (the token-checked approve path) are both proxied to the
// gateway. Same-origin from the browser's point of view, so no CORS; the
// gateway's own Origin allowlist ("http://localhost:*" by default) still
// applies to the forwarded Origin header.
const gateway = process.env["CHAPERONE_GATEWAY_URL"] ?? "http://localhost:3000";
// /control is demo-upstream's scripted mutation trigger, not the gateway's.
// It is proxied only so the rehearsal control on /upstreams can reach it
// from the same origin; the control itself is additionally gated behind
// VITE_DEMO_CONTROLS at build time.
const demoUpstream = process.env["CHAPERONE_DEMO_UPSTREAM_URL"] ?? "http://localhost:4000";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const VIRTUAL = "virtual:chaperone-evidence";

/**
 * Inlines the committed evidence files (crawl reports, boot rate, drift,
 * latency) and the build-time HEAD sha into the bundle. Risk R5: /corpus
 * and /bench must render with no network. Reading these at build time
 * rather than fetching them means the demo works offline and the bundle
 * carries its own provenance.
 *
 * The files are watched in dev, so editing data/drift.json reloads the
 * page rather than requiring a restart.
 */
function evidence(): Plugin {
  const resolved = `\0${VIRTUAL}`;
  return {
    name: "chaperone-evidence",
    resolveId: (id) => (id === VIRTUAL ? resolved : null),
    load: (id) => (id === resolved ? `export default ${JSON.stringify(loadEvidence(repoRoot))};` : null),
    configureServer(server) {
      for (const rel of ["data/crawl-1-report.json", "data/crawl-2-report.json", "data/boot-rate.json", "data/drift.json", "benchmarks/latency.json"]) {
        server.watcher.add(path.join(repoRoot, rel));
      }
      server.watcher.on("all", (_event, file) => {
        if (file.endsWith(".json") && (file.includes(`${path.sep}data${path.sep}`) || file.includes(`${path.sep}benchmarks${path.sep}`))) {
          const mod = server.moduleGraph.getModuleById(resolved);
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: "full-reload" });
          }
        }
      });
    },
  };
}

const proxy = { "/api": gateway, "/mcp": gateway, "/control": demoUpstream };

export default defineConfig({
  plugins: [react(), tailwindcss(), evidence()],
  server: { port: 5173, strictPort: true, proxy },
  // `vite preview` serves the production build; the acceptance run in
  // CLAUDE.md's verify block uses it, so it needs the same proxy table.
  preview: { port: 4173, strictPort: true, proxy },
});
