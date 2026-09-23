import { createAdminClient, ensureTables } from "../src/provision.js";

async function migrate(): Promise<void> {
  await ensureTables(createAdminClient(), (line) => console.log(line));
}

migrate()
  .then(() => {
    console.log("migrate: done");
  })
  .catch((e: unknown) => {
    console.error("migrate: failed —", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
