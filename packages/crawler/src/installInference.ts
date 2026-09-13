import { readFile, writeFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { childLogger } from "@chaperone/logger";
import { getCorpusServer, putCorpusServer } from "@chaperone/ledger";
import { fetchWithPolicy } from "./http.js";
import { CANDIDATES_PATH, type CandidateRecord } from "./assemble.js";

const log = childLogger({ component: "crawler-install-inference" });

export type InstallInferenceResolution =
  | "npm"
  | "pypi"
  | "package-json-no-bin"
  | "pyproject-no-scripts"
  | "not-found"
  | "registry-check-failed";

export interface InstallInferenceOutcome {
  serverId: string;
  resolution: InstallInferenceResolution;
  installMethod?: "npx" | "uvx";
  installSpec?: string;
}

export interface InstallInferenceReport {
  attempted: number;
  resolvedNpm: number;
  resolvedPypi: number;
  packageJsonNoBin: number;
  pyprojectNoScripts: number;
  notFound: number;
  registryCheckFailed: number;
}

interface PackageJsonShape {
  name?: unknown;
  bin?: unknown;
}

interface PyprojectShape {
  project?: {
    name?: unknown;
    scripts?: unknown;
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * `raw.githubusercontent.com` resolves `HEAD` to a repo's actual default
 * branch regardless of its name (confirmed live against real corpus repos —
 * both `main`-default and otherwise — on 2026-09-13, SDK/host behaviour
 * verified rather than assumed per CLAUDE.md). One request per file, no
 * branch-name guessing.
 */
function rawUrl(owner: string, repo: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`;
}

async function fetchPackageJson(owner: string, repo: string): Promise<PackageJsonShape | undefined> {
  const res = await fetchWithPolicy(rawUrl(owner, repo, "package.json"), { sourceId: "install-inference" });
  if (res.status !== 200) {
    return undefined;
  }
  try {
    return JSON.parse(res.body) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

async function fetchPyproject(owner: string, repo: string): Promise<PyprojectShape | undefined> {
  const res = await fetchWithPolicy(rawUrl(owner, repo, "pyproject.toml"), { sourceId: "install-inference" });
  if (res.status !== 200) {
    return undefined;
  }
  try {
    return parseToml(res.body) as PyprojectShape;
  } catch {
    return undefined;
  }
}

async function npmPackageExists(name: string): Promise<boolean> {
  const res = await fetchWithPolicy(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    sourceId: "install-inference",
  });
  return res.status === 200;
}

async function pypiPackageExists(name: string): Promise<boolean> {
  const res = await fetchWithPolicy(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
    sourceId: "install-inference",
  });
  return res.status === 200;
}

/**
 * Resolves one repo-only candidate to a runnable install command without
 * cloning it: read the two manifest shapes that declare an installable CLI
 * entry point, then confirm the named package actually exists on the
 * registry it claims to publish to. A manifest existing is not enough on its
 * own — plenty of repos ship a `package.json` with no `bin`, or a library
 * with no console script — only a confirmed registry hit counts as resolved.
 */
export async function inferInstallForRepo(owner: string, repo: string): Promise<InstallInferenceOutcome> {
  const serverId = `${owner}/${repo}`;

  const pkg = await fetchPackageJson(owner, repo);
  if (pkg) {
    const hasBin = pkg.bin !== undefined && pkg.bin !== null && pkg.bin !== "" && !(Array.isArray(pkg.bin) && pkg.bin.length === 0);
    if (hasBin && isNonEmptyString(pkg.name)) {
      const exists = await npmPackageExists(pkg.name);
      if (exists) {
        return { serverId, resolution: "npm", installMethod: "npx", installSpec: pkg.name };
      }
      return { serverId, resolution: "registry-check-failed" };
    }
  }

  const pyproject = await fetchPyproject(owner, repo);
  if (pyproject) {
    const scripts = pyproject.project?.scripts;
    const hasScripts = typeof scripts === "object" && scripts !== null && Object.keys(scripts).length > 0;
    if (hasScripts && isNonEmptyString(pyproject.project?.name)) {
      const name = pyproject.project.name;
      const exists = await pypiPackageExists(name);
      if (exists) {
        return { serverId, resolution: "pypi", installMethod: "uvx", installSpec: name };
      }
      return { serverId, resolution: "registry-check-failed" };
    }
  }

  if (pkg && !pyproject) {
    return { serverId, resolution: "package-json-no-bin" };
  }
  if (pyproject && !pkg) {
    return { serverId, resolution: "pyproject-no-scripts" };
  }
  return { serverId, resolution: "not-found" };
}

function tallyResolution(report: InstallInferenceReport, resolution: InstallInferenceResolution): void {
  switch (resolution) {
    case "npm":
      report.resolvedNpm++;
      return;
    case "pypi":
      report.resolvedPypi++;
      return;
    case "package-json-no-bin":
      report.packageJsonNoBin++;
      return;
    case "pyproject-no-scripts":
      report.pyprojectNoScripts++;
      return;
    case "not-found":
      report.notFound++;
      return;
    case "registry-check-failed":
      report.registryCheckFailed++;
  }
}

/**
 * Widens `corpus/candidates.json` beyond what the five assembly sources
 * discover: for every candidate with a repo but no known install path, try
 * to infer one from its own manifest (see `inferInstallForRepo`). Writes
 * resolved candidates back to both the on-disk corpus file and the
 * `corpus-server` DDB rows, and reports what happened to every candidate
 * attempted — never silently drops the unresolved ones.
 */
export async function runInstallInference(): Promise<InstallInferenceReport> {
  const raw = await readFile(CANDIDATES_PATH, "utf8");
  const records = JSON.parse(raw) as CandidateRecord[];

  const targets = records.filter(
    (r) => r.installMethod === null && r.repoOwner !== null && r.repoName !== null,
  );

  const report: InstallInferenceReport = {
    attempted: targets.length,
    resolvedNpm: 0,
    resolvedPypi: 0,
    packageJsonNoBin: 0,
    pyprojectNoScripts: 0,
    notFound: 0,
    registryCheckFailed: 0,
  };

  const outcomes = await Promise.all(
    targets.map(async (target) => {
      try {
        return await inferInstallForRepo(target.repoOwner!, target.repoName!);
      } catch (e) {
        log.warn(
          { serverId: target.serverId, error: e instanceof Error ? e.message : String(e) },
          "install inference failed for candidate; recording as not-found",
        );
        return { serverId: target.serverId, resolution: "not-found" as const };
      }
    }),
  );

  const outcomeByServerId = new Map(targets.map((t, i) => [t.serverId, outcomes[i]!]));

  for (const record of records) {
    const outcome = outcomeByServerId.get(record.serverId);
    if (!outcome) {
      continue;
    }
    tallyResolution(report, outcome.resolution);
    if (outcome.installMethod && outcome.installSpec) {
      record.installMethod = outcome.installMethod;
      record.installSpec = outcome.installSpec;

      const existing = await getCorpusServer(record.serverId);
      if (existing) {
        await putCorpusServer({
          ...existing,
          installMethod: outcome.installMethod,
          installSpec: outcome.installSpec,
        });
      }
    }
  }

  await writeFile(CANDIDATES_PATH, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  log.info(
    {
      attempted: report.attempted,
      resolvedNpm: report.resolvedNpm,
      resolvedPypi: report.resolvedPypi,
    },
    "install inference complete",
  );

  return report;
}
