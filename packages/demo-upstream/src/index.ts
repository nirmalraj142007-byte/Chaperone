import { childLogger } from "@chaperone/logger";
import { buildApp } from "./http.js";

const log = childLogger({ component: "demo-upstream" });
const port = Number(process.env["PORT"] ?? 4000);

buildApp().listen(port, () => {
  log.info({ port }, `demo-upstream listening at http://localhost:${port}/mcp`);
});
