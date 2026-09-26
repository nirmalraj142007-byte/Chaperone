/**
 * `pnpm demo:assistant` — serves the simulated Alexa+ experience
 * (packages/assistant-sim) on http://localhost:5174, the primary demo
 * surface. It talks to the gateway on :3000 through a proxy on its own
 * origin, so the stack must be up (`docker compose up -d`, `pnpm demo:reset`).
 *
 * Builds the bundle first if it is missing or stale, then runs `vite preview`
 * in the foreground. Ctrl+C stops it.
 */
import { spawn } from "node:child_process";
import { ASSISTANT_DIR, assistantViteBin, ensureAssistantBundle } from "./demo/assistant.js";
import { STACK } from "./demo/env.js";

ensureAssistantBundle((line) => console.log(line));

const gatewayUp = await fetch(`${STACK.gatewayUrl}/healthz`).then(
  (res) => res.ok,
  () => false,
);
if (!gatewayUp) {
  console.warn(`demo:assistant: the gateway at ${STACK.gatewayUrl} is not answering /healthz. The page will say so. Start the stack: docker compose up -d && pnpm demo:reset`);
}

console.log(`demo:assistant: serving the simulated Alexa+ experience at ${STACK.assistantUrl}`);
const child = spawn(process.execPath, [assistantViteBin(), "preview", "--port", "5174", "--strictPort"], {
  cwd: ASSISTANT_DIR,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
