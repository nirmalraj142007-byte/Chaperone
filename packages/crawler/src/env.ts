import { z } from "zod";
import { ConfigError } from "@chaperone/errors";

/**
 * The crawler's own env knobs, separate from @chaperone/config's schema:
 * these tune a one-off assembly run (per-source fetch caps, cache paths, a
 * test-only host-blocking switch) and are meaningless to the gateway or
 * ledger, so they don't belong in the shared runtime config.
 */
const envSchema = z.object({
  /**
   * Raised from an initial 150/150 after a pre-crawl-1 composition check
   * (2026-09-13) found the default caps left registry and Smithery each
   * sampled from well under 3% of what they actually have on offer
   * (thousands of registry entries; Smithery alone reports 14,502), while
   * awesome-mcp-servers — a single hobby-maintained README — ended up
   * contributing 350/610 (57%) with zero cross-source overlap. 400/400
   * pulls registry and Smithery's institutional/hosted servers roughly to
   * parity with the hobby-repo share rather than leaving them as a rounding
   * error next to it.
   */
  CRAWLER_REGISTRY_LIMIT: z.coerce.number().int().positive().default(400),
  CRAWLER_SMITHERY_LIMIT: z.coerce.number().int().positive().default(400),
  CRAWLER_AWESOME_LIMIT: z.coerce.number().int().positive().default(350),
  CRAWLER_MIN_TOTAL: z.coerce.number().int().positive().default(300),
  CRAWLER_HTTP_CACHE_DIR: z.string().min(1).default("packages/crawler/.cache/http"),
  CRAWLER_RAW_ARCHIVE_DIR: z.string().min(1).default("packages/crawler/.cache/raw"),
  CRAWLER_CONTACT_URL: z.string().url().default("https://github.com/nirmalraj142007-byte/Chaperone"),
  /**
   * Comma-separated hostnames to treat as unreachable. This is the "env flag
   * for this purpose" the Phase 4 acceptance test asks for, in place of an
   * /etc/hosts edit that would need admin rights on every machine that runs
   * this: `CRAWLER_BLOCKED_HOSTS=registry.smithery.ai pnpm crawl:assemble`
   * simulates that host being down without touching real network config.
   */
  CRAWLER_BLOCKED_HOSTS: z.string().default(""),
  PULSEMCP_API_KEY: z.string().min(1).optional(),
  PULSEMCP_TENANT_ID: z.string().min(1).optional(),
  GLAMA_API_KEY: z.string().min(1).optional(),
  /**
   * Read independently of @chaperone/config's own GITHUB_TOKEN key (both
   * just read the same underlying env var) so commit-recency.ts doesn't
   * need CHAPERONE_UPSTREAMS and the rest of the gateway's required config
   * just to check GitHub. No scopes are required — public-repo metadata
   * reads only need authentication to raise the rate ceiling from 60/hour
   * to 5000/hour.
   */
  GITHUB_TOKEN: z.string().min(1).optional(),
});

export interface CrawlerEnv {
  registryLimit: number;
  smitheryLimit: number;
  awesomeLimit: number;
  minTotal: number;
  httpCacheDir: string;
  rawArchiveDir: string;
  contactUrl: string;
  blockedHosts: string[];
  pulsemcpApiKey?: string;
  pulsemcpTenantId?: string;
  glamaApiKey?: string;
  githubToken?: string;
}

const EXPECTED_SHAPE: Record<string, string> = {
  CRAWLER_REGISTRY_LIMIT: "positive integer (default 400)",
  CRAWLER_SMITHERY_LIMIT: "positive integer (default 400)",
  CRAWLER_AWESOME_LIMIT: "positive integer (default 350)",
  CRAWLER_MIN_TOTAL: "positive integer (default 300)",
  CRAWLER_HTTP_CACHE_DIR: "non-empty string (default packages/crawler/.cache/http)",
  CRAWLER_RAW_ARCHIVE_DIR: "non-empty string (default packages/crawler/.cache/raw)",
  CRAWLER_CONTACT_URL: "URL (default the project repo)",
  CRAWLER_BLOCKED_HOSTS: "comma-separated hostnames, may be empty",
  PULSEMCP_API_KEY: "string, optional",
  PULSEMCP_TENANT_ID: "string, optional",
  GLAMA_API_KEY: "string, optional",
  GITHUB_TOKEN: "string, optional",
};

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    const shape = EXPECTED_SHAPE[key] ?? "unknown";
    return `  ${key}: expected ${shape} — ${issue.message}`;
  });
  return `Invalid crawler environment configuration:\n${lines.join("\n")}`;
}

let cached: CrawlerEnv | undefined;

export function loadCrawlerEnv(): CrawlerEnv {
  if (cached) {
    return cached;
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error), { issues: result.error.issues });
  }

  const env = result.data;
  cached = {
    registryLimit: env.CRAWLER_REGISTRY_LIMIT,
    smitheryLimit: env.CRAWLER_SMITHERY_LIMIT,
    awesomeLimit: env.CRAWLER_AWESOME_LIMIT,
    minTotal: env.CRAWLER_MIN_TOTAL,
    httpCacheDir: env.CRAWLER_HTTP_CACHE_DIR,
    rawArchiveDir: env.CRAWLER_RAW_ARCHIVE_DIR,
    contactUrl: env.CRAWLER_CONTACT_URL,
    blockedHosts: env.CRAWLER_BLOCKED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean),
    ...(env.PULSEMCP_API_KEY !== undefined ? { pulsemcpApiKey: env.PULSEMCP_API_KEY } : {}),
    ...(env.PULSEMCP_TENANT_ID !== undefined ? { pulsemcpTenantId: env.PULSEMCP_TENANT_ID } : {}),
    ...(env.GLAMA_API_KEY !== undefined ? { glamaApiKey: env.GLAMA_API_KEY } : {}),
    ...(env.GITHUB_TOKEN !== undefined ? { githubToken: env.GITHUB_TOKEN } : {}),
  };

  return cached;
}

export function resetCrawlerEnvForTests(): void {
  cached = undefined;
}
