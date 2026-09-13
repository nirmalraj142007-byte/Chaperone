// @modelcontextprotocol/sdk verified at v1.30.0 (2026-09-13, per CLAUDE.md's
// "verify rather than remember" rule — node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0/.../dist/esm):
//   - `StdioClientTransport` (client/stdio.js) spawns `command`/`args` with
//     the given `env` (defaulting to `getDefaultEnvironment()`, a small
//     inherited-var allowlist — PATH/USERPROFILE/etc. on win32 — never the
//     full host environment) and, when `stderr: "pipe"`, exposes the child's
//     stderr as a readable stream via `.stderr`.
//   - `Client#connect(transport, options)` performs the `initialize`
//     handshake itself; `options.timeout` (RequestOptions, shared/protocol.d.ts)
//     bounds that request end-to-end regardless of *why* no response ever
//     arrives (slow install, hung process, or genuinely stuck) and rejects
//     with an McpError(RequestTimeout) — this is what stands in for "SIGKILL
//     after 90s/30s" at the protocol layer; the container itself is killed
//     separately in `finally` (see `forceRemoveContainer` below), since
//     closing the transport only detaches from the local `docker run`
//     client process and does not by itself guarantee the daemon-side
//     container stops.
//   - `Client#listTools()` returns `{ tools: [{ name, description?,
//     inputSchema, ... }] }` — `name`/`description`/`inputSchema` are taken
//     verbatim into `ToolDefinition`, everything else (annotations, icons,
//     outputSchema, …) is dropped, matching the phase's "capture verbatim"
//     instruction literally rather than archiving SDK-added fields as if the
//     server had claimed them.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { childLogger } from "@chaperone/logger";
import type { ToolDefinition } from "@chaperone/policy";
import { extractDeclaredEnvVarNames } from "./credentialScan.js";
import { fetchRepoReadme } from "./readme.js";

const execFileAsync = promisify(execFile);
const log = childLogger({ component: "crawler-boot" });

export type BootStatus =
  | "BOOTED"
  | "FAILED_INSTALL"
  | "FAILED_START"
  | "FAILED_TIMEOUT"
  | "REFUSED_NO_CREDS"
  | "NO_INSTALL_PATH";

export interface BootResult {
  serverId: string;
  status: BootStatus;
  tools: ToolDefinition[];
  stderrTail: string;
  durationMs: number;
  transport: "stdio" | "http" | "unknown";
}

/**
 * The subset of a corpus candidate (`CandidateRecord` /
 * `@chaperone/ledger`'s `CorpusServer`) that booting actually needs — kept
 * narrow and structural rather than importing either concrete type, so
 * `crawl.ts` can pass either one straight through.
 */
export interface BootCandidate {
  serverId: string;
  repoOwner: string | null;
  repoName: string | null;
  installMethod: string | null;
  installSpec: string | null;
}

export interface BootOptions {
  /**
   * Start-phase timeout in ms — how long, after the install/launch command
   * has been running, we wait for a working `initialize` handshake. The
   * literal phase budgets from the prompt (90s install / 30s start) don't
   * map onto a single number, since npx/uvx never expose an observable
   * install/start boundary (they self-install and run in one blocking
   * call) — so the *install* budget (`INSTALL_PHASE_MS`, fixed at 90s) is
   * always applied first internally, and `timeoutMs` here is additive on
   * top of it. A caller wanting the documented 90s/30s split passes 30_000.
   */
  timeoutMs: number;
  network: "none" | "allowlist";
}

export const INSTALL_PHASE_MS = 90_000;

const RUNTIME_IMAGE = "chaperone/crawler-runtime:latest";
const PROXY_IMAGE = "chaperone/crawl-proxy:latest";
const PROXY_CONTAINER = "chaperone-crawl-proxy";
const INTERNAL_NETWORK = "chaperone-crawl-internal";
const INTERNAL_SUBNET = "172.28.0.0/16";
const EGRESS_NETWORK = "chaperone-crawl-egress";
const PROXY_URL = "http://proxy:3128";
const MAX_STDERR_CAPTURE = 4_000;
const PLACEHOLDER_VALUE = "placeholder-not-a-real-key";
const FALLBACK_PLACEHOLDER_VARS = ["API_KEY", "TOKEN"];
const AUTOMATABLE_METHODS = new Set(["npx", "uvx", "pip"]);
/** Package name, optionally with extras (`package[extra1,extra2]`) — deliberately rejects whitespace and shell metacharacters. */
const PIP_PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,_-]+\])?$/;

/** Credential-refusal signal in a process's own stderr — distinct from, and checked before, a generic start failure. */
const REFUSAL_STDERR_PATTERN = /API[_-]?KEY|TOKEN|SECRET|CLIENT_ID|UNAUTHORIZED|401\b|credentials?|authentication failed/i;

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The two source shapes seen in the corpus disagree on whether `spec`
 * already includes the launcher word: the registry source's identifiers are
 * bare (`@foo/bar`), awesome-mcp-servers' code-span extraction keeps
 * whatever the README author typed, launcher prefix included (`npx -y
 * @foo/bar`). Strips a leading `npx`/`uvx` token if present so either shape
 * normalizes to the same trailing argv.
 */
function stripLauncherPrefix(launcher: "npx" | "uvx", spec: string): string[] {
  const trimmed = spec.trim();
  const withoutPrefix = new RegExp(`^${launcher}\\b`).test(trimmed) ? trimmed.replace(new RegExp(`^${launcher}\\s*`), "") : trimmed;
  return withoutPrefix.split(/\s+/).filter(Boolean);
}

/**
 * Builds the one shell command run inside the container. Every method funnels
 * into a single `sh -c` invocation (rather than a separate install-then-run
 * pair of `docker run`s) because npx/uvx don't expose an install step we
 * could run separately even if we wanted to — `pip` gets an explicit
 * `install` step ahead of the `exec` for the same reason a real operator
 * would write it that way, not because the harness treats it specially.
 */
export function buildShellCommand(installMethod: string, installSpec: string): string {
  switch (installMethod) {
    case "npx": {
      const args = stripLauncherPrefix("npx", installSpec);
      const withFlag = args.includes("-y") || args.includes("--yes") ? args : ["-y", ...args];
      return `exec npx ${withFlag.map(shellQuote).join(" ")}`;
    }
    case "uvx": {
      const args = stripLauncherPrefix("uvx", installSpec);
      return `exec uvx ${args.map(shellQuote).join(" ")}`;
    }
    case "pip": {
      // Convention official Python MCP servers follow (mcp-server-git,
      // mcp-server-fetch, ...): pip installs a console-script entry point
      // named after the package itself. Flagged assumption — small
      // population (15 candidates as of 2026-09-13).
      const pkg = installSpec.trim();
      if (!PIP_PACKAGE_NAME_PATTERN.test(pkg)) {
        // A real corpus example: awesome-mcp-servers' README-code-span
        // extraction can hand back a compound shell snippet — e.g.
        // "pillow && python3 image_mcp.py" — for a `pip install <x>` span
        // that was never a bare package name to begin with. That's not a
        // package this method knows how to install; it's an admission that
        // the extracted "spec" isn't a package identifier at all.
        throw new RangeError(`buildShellCommand: "${pkg}" is not a plausible pip package name`);
      }
      return `pip install --no-input --disable-pip-version-check ${shellQuote(pkg)} >/tmp/pip-install.log 2>&1 && exec ${shellQuote(pkg)}`;
    }
    default:
      throw new RangeError(`buildShellCommand: unsupported installMethod "${installMethod}"`);
  }
}

/**
 * The corpus records only a boolean `requiresCredentials`, never which
 * variables a server actually declares (see `extractDeclaredEnvVarNames`).
 * Placeholders are real strings a caller can grep for
 * (`placeholder-not-a-real-key`) — the host environment is never read.
 */
async function buildPlaceholderEnv(candidate: BootCandidate): Promise<Record<string, string>> {
  const names = new Set(FALLBACK_PLACEHOLDER_VARS);
  if (candidate.repoOwner && candidate.repoName) {
    const readme = await fetchRepoReadme({ owner: candidate.repoOwner, name: candidate.repoName });
    if (readme) {
      for (const name of extractDeclaredEnvVarNames(readme)) {
        names.add(name);
      }
    }
  }
  return Object.fromEntries([...names].map((name) => [name, PLACEHOLDER_VALUE]));
}

function buildDockerArgs(containerName: string, shellCommand: string, placeholderEnv: Record<string, string>, network: "none" | "allowlist"): string[] {
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    "--memory=512m",
    "--cpus=1",
    "--pids-limit=256",
    "--read-only",
    // Docker's bare `--tmpfs /tmp` defaults to `noexec` — every install
    // method here (npx, pip, uvx) downloads code and then executes it from
    // /tmp, so a noexec tmpfs makes every single boot attempt fail with a
    // misleading "Permission denied" despite correct file permissions
    // (confirmed empirically 2026-09-13: rwxr-xr-x on the target file,
    // `mount` showing `tmpfs on /tmp type tmpfs (rw,nosuid,nodev,noexec,...)`).
    // `exec` must be requested explicitly; size raised from Docker's 64m
    // default since some npx installs pull a non-trivial dependency tree.
    "--tmpfs",
    "/tmp:rw,exec,nosuid,size=1g",
  ];

  if (network === "allowlist") {
    args.push("--network", INTERNAL_NETWORK);
  } else {
    args.push("--network", "none");
  }

  const env: Record<string, string> = {
    HOME: "/tmp",
    NPM_CONFIG_CACHE: "/tmp/npm-cache",
    npm_config_prefix: "/tmp/npm-global",
    PIP_CACHE_DIR: "/tmp/pip-cache",
    UV_CACHE_DIR: "/tmp/uv-cache",
    ...(network === "allowlist"
      ? { HTTP_PROXY: PROXY_URL, HTTPS_PROXY: PROXY_URL, http_proxy: PROXY_URL, https_proxy: PROXY_URL }
      : {}),
    ...placeholderEnv,
  };
  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(RUNTIME_IMAGE, "sh", "-c", shellCommand);
  return args;
}

/**
 * `transport.close()` only detaches the local `docker run` client process —
 * it does not, by itself, guarantee the daemon-side container is gone (a
 * SIGKILL'd `docker` CLI has no chance to forward anything to dockerd, and
 * `docker run` without `-d` otherwise keeps the container running
 * independently of its attached client). Every boot attempt gets a unique
 * `--name`, and this always runs in `finally` regardless of outcome — the
 * one guaranteed cleanup path so a multi-hundred-server crawl doesn't leak
 * running containers.
 */
async function forceRemoveContainer(containerName: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "-f", containerName], { timeout: 10_000 });
  } catch {
    // Already gone via --rm on natural exit, or never created — either way, nothing left to clean up.
  }
}

function tail(text: string, max = MAX_STDERR_CAPTURE): string {
  return text.length > max ? text.slice(-max) : text;
}

interface FailureClassification {
  status: Exclude<BootStatus, "BOOTED" | "NO_INSTALL_PATH">;
}

function classifyFailure(elapsedMs: number, totalTimeoutMs: number, stderrText: string): FailureClassification {
  if (REFUSAL_STDERR_PATTERN.test(stderrText)) {
    return { status: "REFUSED_NO_CREDS" };
  }
  if (elapsedMs >= totalTimeoutMs) {
    return { status: "FAILED_TIMEOUT" };
  }
  if (elapsedMs < INSTALL_PHASE_MS) {
    return { status: "FAILED_INSTALL" };
  }
  return { status: "FAILED_START" };
}

async function commandSucceeds(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(cmd, args, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureImage(tag: string, dockerfile: string, context: string): Promise<void> {
  if (await commandSucceeds("docker", ["image", "inspect", tag])) {
    return;
  }
  log.info({ tag, dockerfile }, "building docker image for the boot harness");
  await execFileAsync("docker", ["build", "-f", dockerfile, "-t", tag, context], {
    timeout: 300_000,
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function ensureNetwork(name: string, extraArgs: string[]): Promise<void> {
  if (await commandSucceeds("docker", ["network", "inspect", name])) {
    return;
  }
  await execFileAsync("docker", ["network", "create", ...extraArgs, name]);
}

async function isProxyRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", PROXY_CONTAINER]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function ensureProxyRunning(): Promise<void> {
  if (await isProxyRunning()) {
    return;
  }
  await execFileAsync("docker", ["rm", "-f", PROXY_CONTAINER]).catch(() => undefined);
  await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    PROXY_CONTAINER,
    "--network",
    INTERNAL_NETWORK,
    "--network-alias",
    "proxy",
    PROXY_IMAGE,
  ]);
  await execFileAsync("docker", ["network", "connect", EGRESS_NETWORK, PROXY_CONTAINER]);
}

/**
 * Idempotent setup for everything `bootAndList` assumes already exists: the
 * two images, the two-network topology (an `--internal` network with no
 * route out, bridged to a real-internet network only by the proxy
 * container — see docker/proxy/ — so a boot attempt's only path to the
 * internet is through the egress allowlist), and the proxy container
 * itself. Safe to call at the start of every crawl run — each step checks
 * before creating.
 */
/**
 * `bootAndList`'s own `finally` block force-removes its container on every
 * normal exit path, but that code never runs if the *harness process
 * itself* is killed (Ctrl+C, a crash, `kill -9` on the crawl) — confirmed
 * empirically 2026-09-13: killing a running crawl mid-boot left 4
 * `chaperone-boot-*` containers running indefinitely, still attempting
 * installs no one was waiting on. Run once at the start of every crawl so a
 * prior interrupted run's leftovers never accumulate across resumes.
 */
async function cleanupOrphanedContainers(): Promise<void> {
  let names: string[];
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      "name=^chaperone-boot-",
      "--format",
      "{{.Names}}",
    ]);
    names = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return;
  }
  if (names.length > 0) {
    log.info({ count: names.length, names }, "removing orphaned boot containers from a prior interrupted run");
  }
  await Promise.all(names.map((name) => forceRemoveContainer(name)));
}

export async function ensureCrawlInfrastructure(): Promise<void> {
  await ensureImage(RUNTIME_IMAGE, path.join("docker", "crawler-runtime.Dockerfile"), "docker");
  await ensureImage(PROXY_IMAGE, path.join("docker", "proxy", "Dockerfile"), path.join("docker", "proxy"));
  await ensureNetwork(INTERNAL_NETWORK, ["--internal", `--subnet=${INTERNAL_SUBNET}`]);
  await ensureNetwork(EGRESS_NETWORK, []);
  await ensureProxyRunning();
  await cleanupOrphanedContainers();
}

/**
 * Boots one candidate in an isolated, network-restricted container, calls
 * `tools/list` over stdio, and reports what happened — every outcome
 * (including every failure mode) is a `BootResult`, never a thrown error;
 * a server that fails to boot is a result, not something for this function
 * to suppress.
 */
export async function bootAndList(candidate: BootCandidate, opts: BootOptions): Promise<BootResult> {
  const startedAt = Date.now();
  const noResult = (status: BootStatus): BootResult => ({
    serverId: candidate.serverId,
    status,
    tools: [],
    stderrTail: "",
    durationMs: Date.now() - startedAt,
    transport: "unknown",
  });

  if (
    candidate.installMethod === null ||
    candidate.installSpec === null ||
    !AUTOMATABLE_METHODS.has(candidate.installMethod)
  ) {
    return noResult("NO_INSTALL_PATH");
  }

  const totalTimeoutMs = INSTALL_PHASE_MS + opts.timeoutMs;
  let shellCommand: string;
  try {
    shellCommand = buildShellCommand(candidate.installMethod, candidate.installSpec);
  } catch (e) {
    // The corpus's "installSpec" isn't always a real command — see
    // buildShellCommand's pip case. An unusable spec is exactly what
    // NO_INSTALL_PATH means, whether that's because nothing was ever
    // extracted or because what was extracted doesn't parse as a command.
    log.debug(
      { serverId: candidate.serverId, error: e instanceof Error ? e.message : String(e) },
      "boot: installSpec did not produce a runnable command",
    );
    return noResult("NO_INSTALL_PATH");
  }
  const placeholderEnv = await buildPlaceholderEnv(candidate);
  const containerName = `chaperone-boot-${candidate.serverId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 100)}-${randomUUID().slice(0, 8)}`;
  const dockerArgs = buildDockerArgs(containerName, shellCommand, placeholderEnv, opts.network);

  const transport = new StdioClientTransport({
    command: "docker",
    args: dockerArgs,
    env: getDefaultEnvironment(),
    stderr: "pipe",
  });

  let stderrBuf = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf = tail(stderrBuf + chunk.toString("utf8"));
  });

  const client = new Client({ name: "chaperone-crawler", version: "0.1.0" }, { capabilities: {} });

  try {
    try {
      await client.connect(transport, { timeout: totalTimeoutMs });
    } catch (e) {
      const elapsedMs = Date.now() - startedAt;
      log.debug(
        { serverId: candidate.serverId, elapsedMs, error: e instanceof Error ? e.message : String(e) },
        "boot: initialize failed",
      );
      const { status } = classifyFailure(elapsedMs, totalTimeoutMs, stderrBuf);
      return { serverId: candidate.serverId, status, tools: [], stderrTail: tail(stderrBuf), durationMs: elapsedMs, transport: "stdio" };
    }

    try {
      const { tools } = await client.listTools(undefined, { timeout: Math.max(5_000, opts.timeoutMs) });
      const captured: ToolDefinition[] = tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema,
      }));
      return {
        serverId: candidate.serverId,
        status: "BOOTED",
        tools: captured,
        stderrTail: tail(stderrBuf),
        durationMs: Date.now() - startedAt,
        transport: "stdio",
      };
    } catch (e) {
      const elapsedMs = Date.now() - startedAt;
      log.debug(
        { serverId: candidate.serverId, elapsedMs, error: e instanceof Error ? e.message : String(e) },
        "boot: initialize succeeded but tools/list failed",
      );
      return { serverId: candidate.serverId, status: "FAILED_START", tools: [], stderrTail: tail(stderrBuf), durationMs: elapsedMs, transport: "stdio" };
    }
  } finally {
    await client.close().catch(() => undefined);
    await forceRemoveContainer(containerName);
  }
}
