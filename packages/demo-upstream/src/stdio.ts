import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { childLogger } from "@chaperone/logger";
import { buildGroceryServer } from "./server.js";

const log = childLogger({ component: "demo-upstream-stdio" });

async function main(): Promise<void> {
  const { server } = buildGroceryServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("demo-upstream stdio server connected");
}

main().catch((error: unknown) => {
  log.error({ error }, "demo-upstream stdio server failed to start");
  process.exitCode = 1;
});
