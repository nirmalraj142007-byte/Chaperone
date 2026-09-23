import { z } from "zod";
import { ConfigError } from "@chaperone/errors";

/**
 * Advisory's own knob, separate from `@chaperone/config`'s schema: where
 * `changelog.ts` caches successful GitHub REST responses on disk. Everything
 * else the advisory pipeline needs — household id, `ADVISORY_MODEL_ID`,
 * `GITHUB_TOKEN`, AWS region — already lives in `@chaperone/config`, which
 * localRunner.ts's caller (packages/advisory/scripts/run-local.ts) reads
 * directly rather than this duplicating it.
 */
const envSchema = z.object({
  ADVISORY_GITHUB_CACHE_DIR: z.string().min(1).default("packages/advisory/.cache/github"),
});

export interface AdvisoryEnv {
  githubCacheDir: string;
}

const EXPECTED_SHAPE: Record<string, string> = {
  ADVISORY_GITHUB_CACHE_DIR: "non-empty string (default packages/advisory/.cache/github)",
};

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    const shape = EXPECTED_SHAPE[key] ?? "unknown";
    return `  ${key}: expected ${shape} — ${issue.message}`;
  });
  return `Invalid advisory environment configuration:\n${lines.join("\n")}`;
}

let cached: AdvisoryEnv | undefined;

export function loadAdvisoryEnv(): AdvisoryEnv {
  if (cached) {
    return cached;
  }
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error), { issues: result.error.issues });
  }
  cached = { githubCacheDir: result.data.ADVISORY_GITHUB_CACHE_DIR };
  return cached;
}

export function resetAdvisoryEnvForTests(): void {
  cached = undefined;
}
