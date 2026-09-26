/**
 * `pnpm demo:reset` — put the whole demo back to its staged starting state,
 * offline, from committed inputs only.
 *
 *   1. make sure DynamoDB Local and demo-upstream are running
 *   2. drop and recreate the demo-owned tables (pins, quarantines, ledger
 *      events, sessions, SSE events, advisory). The crawler's tables
 *      (tool-snapshot, corpus-server, drift-record) are never touched; see
 *      tables.ts. The plan is printed before anything is dropped.
 *   3. return demo-upstream to its benign descriptions
 *   4. seed household-demo: connect to demo-upstream, pin every tool it
 *      lists, approved 12 January 2026 (a staged fixture; see stage.ts)
 *   5. write the advisory fixtures (see demo/advisory-fixtures.json)
 *   6. check the ledger chain, and that the console's evidence is the
 *      committed files
 *
 * Nothing here calls out of the machine. The only external process is
 * `docker compose` and, if the console or simulated-assistant bundle is
 * stale, `vite build`.
 */
import { execFileSync } from "node:child_process";
import { STACK, assertLocalDynamoDb } from "./env.js";
import { loadConfig } from "@chaperone/config";
import {
  createAdminClient,
  ensureTables,
  putFixtureAdvisory,
  tableExists,
  tableName,
  verifyChain,
} from "@chaperone/ledger";
import { getPool } from "@chaperone/upstream";
import { hashTool, type ToolDefinition } from "@chaperone/policy";
import { ensureAssistantBundle } from "./assistant.js";
import { ensureConsoleBundle } from "./console.js";
import { REPO_ROOT, loadFixtureFile } from "./fixtures.js";
import { dropDemoTables, planDemoDrop } from "./tables.js";
import { stageApprovedPins, STAGED_APPROVED_AT, type StagedPin } from "./stage.js";
import { loadEvidence } from "../../packages/console/evidence.load.js";

export interface ResetOptions {
  /** Skip `docker compose up`; assume the stack is already running. */
  skipDocker?: boolean;
  /** Skip the console and simulated-assistant bundle checks/builds. */
  skipConsole?: boolean;
  log?: (line: string) => void;
}

export interface ResetResult {
  pins: StagedPin[];
  fixtureHashes: Array<{ id: string; toHash: string }>;
  ledgerEvents: number;
  corpusState: "PARTIAL" | "COMPLETE" | "EMPTY";
  evidence: { crawl1StartedAt: string | null; driftStatus: string | null };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} did not become ready within ${timeoutMs / 1000}s`);
    }
    await sleep(500);
  }
}

/** `docker compose up -d` for the whole stack. Honours COMPOSE_FILE, so the offline overlay applies when it is set. */
function composeUp(): void {
  try {
    execFileSync("docker", ["compose", "up", "-d"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
    throw new Error(
      "`docker compose up -d` failed. Is Docker running, and were the images built once " +
        `(\`docker compose build\`, which needs the network the first time)?
${stderr}`,
    );
  }
}

async function ensureStack(log: (line: string) => void, skipDocker: boolean): Promise<void> {
  if (!skipDocker) {
    // The whole stack, not just the two services the reset itself talks to: under
    // docker/compose.offline.yml the host reaches them only through `edge`.
    log("stack: docker compose up -d");
    composeUp();
  }
  await waitFor("DynamoDB Local", async () => {
    await tableExists(createAdminClient(), tableName("pin"));
    return true;
  });
  await waitFor("demo-upstream", async () => (await fetch(`${STACK.demoUpstreamUrl}/control/stats`)).ok);
}

async function control(pathAndQuery: string): Promise<void> {
  const res = await fetch(`${STACK.demoUpstreamUrl}${pathAndQuery}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: pathAndQuery.includes("place-order-delay") ? JSON.stringify({ delayMs: 0 }) : "{}",
  });
  if (!res.ok) {
    throw new Error(`demo-upstream ${pathAndQuery} answered ${res.status}`);
  }
}

function toPolicyTool(tool: { name: string; description?: string | undefined; inputSchema: unknown }): ToolDefinition {
  return {
    name: tool.name,
    inputSchema: tool.inputSchema as ToolDefinition["inputSchema"],
    ...(tool.description !== undefined ? { description: tool.description } : {}),
  };
}

// --- the reset ------------------------------------------------------------

export async function resetDemo(options: ResetOptions = {}): Promise<ResetResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  assertLocalDynamoDb();
  const config = loadConfig();
  const fixtures = loadFixtureFile();

  await ensureStack(log, options.skipDocker === true);

  const adminClient = createAdminClient();
  const plan = await planDemoDrop(adminClient);
  const dropped = await dropDemoTables(adminClient, plan, log);
  // Creates the tables just dropped, and any that were absent. Crawl-owned
  // tables that already exist (with their rows) are skipped, not recreated.
  const { created } = await ensureTables(adminClient);
  log(`tables: dropped ${dropped}, created ${created.length}`);

  await control("/control/reset");
  await control("/control/place-order-delay");
  log("demo-upstream: reset to its benign descriptions");

  const pool = await getPool(config.upstreams);
  try {
    const listed = await pool.listAllTools();
    for (const upstream of config.upstreams) {
      if (!listed.some((entry) => entry.upstreamId === upstream.id)) {
        throw new Error(`upstream "${upstream.id}" (${upstream.url}) listed no tools; is demo-upstream healthy?`);
      }
    }
    const tools = listed.map(({ upstreamId, tool }) => ({ upstreamId, tool: toPolicyTool(tool) }));
    const pins = await stageApprovedPins(config.householdId, tools);
    log(`household: ${config.householdId} pinned ${pins.length} tools, approvedAt ${STAGED_APPROVED_AT} (staged fixture)`);

    // The advisory fixtures attach to the hash of the definition the
    // upstream really serves once mutated, read from the upstream itself,
    // then the upstream is put back. The fixture says what the change is;
    // it never gets to choose which hash it is attached to.
    const fixtureHashes: ResetResult["fixtureHashes"] = [];
    await control("/control/mutate");
    try {
      const mutated = await pool.listAllTools();
      for (const row of fixtures.rows) {
        const entry = mutated.find((e) => e.upstreamId === row.upstreamId && e.tool.name === row.toolName);
        if (entry === undefined) {
          throw new Error(`fixture "${row.id}": ${row.upstreamId}/${row.toolName} is not listed by the upstream`);
        }
        const definition = toPolicyTool(entry.tool);
        if (!(definition.description ?? "").includes(row.mustContainAddedText)) {
          throw new Error(
            `fixture "${row.id}" no longer describes the change demo-upstream makes: its description lacks ` +
              `"${row.mustContainAddedText}". Update demo/advisory-fixtures.json.`,
          );
        }
        const toHash = hashTool(definition);
        await putFixtureAdvisory(toHash, {
          quarantineId: `fixture:${row.id}`,
          score: row.score,
          summary: row.summary,
          modelId: fixtures.modelId,
          generatedAt: `${fixtures.writtenOn}T00:00:00.000Z`,
          promptSha: "fixture",
        });
        fixtureHashes.push({ id: row.id, toHash });
      }
    } finally {
      await control("/control/reset");
    }
    log(`advisory: ${fixtureHashes.length} hand-written fixture row(s) written (labelled fixtures, not model output)`);

    const restored = await pool.listAllTools();
    for (const pin of pins) {
      const now = restored.find((e) => e.upstreamId === pin.upstreamId && e.tool.name === pin.toolName);
      if (now === undefined || hashTool(toPolicyTool(now.tool)) !== pin.hash) {
        throw new Error(
          `after reset, ${pin.upstreamId}/${pin.toolName} does not hash to its pin; demo-upstream did not return to its benign state`,
        );
      }
    }

    const chain = await verifyChain(config.householdId);
    if (!chain.ok) {
      throw new Error(`ledger chain is broken right after staging, at index ${chain.index} (${chain.reason})`);
    }
    log(`ledger: chain verified, ${chain.count} events`);

    if (options.skipConsole !== true) {
      ensureConsoleBundle(log);
      ensureAssistantBundle(log);
    }
    const evidence = loadEvidence(REPO_ROOT);
    const driftStatus = evidence.drift?.status ?? null;
    const corpusState = evidence.crawl1 === null ? "EMPTY" : driftStatus === "complete" ? "COMPLETE" : "PARTIAL";
    log(
      `console: /corpus reads committed files only; crawl 1 ${evidence.crawl1?.startedAt ?? "absent"}, ` +
        `drift.json status ${driftStatus ?? "absent"} -> ${corpusState}`,
    );

    return {
      pins,
      fixtureHashes,
      ledgerEvents: chain.count,
      corpusState,
      evidence: { crawl1StartedAt: evidence.crawl1?.startedAt ?? null, driftStatus },
    };
  } finally {
    await pool.close();
  }
}
