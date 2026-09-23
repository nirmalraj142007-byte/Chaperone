import { z } from "zod";
import { ConfigError } from "@chaperone/errors";

const upstreamSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  label: z.string().min(1),
});

export interface UpstreamConfig {
  id: string;
  url: string;
  label: string;
}

const upstreamsField = z
  .string({ required_error: "Required" })
  .min(1, "Required")
  .transform((raw, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be valid JSON",
      });
      return z.NEVER;
    }

    const result = z.array(upstreamSchema).min(1).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a JSON array of {id: string, url: string, label: string}",
      });
      return z.NEVER;
    }

    return result.data;
  });

const originAllowlistField = z
  .string()
  .min(1)
  .default("http://localhost:*")
  .transform((raw) =>
    raw
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );

const envSchema = z.object({
  AWS_REGION: z.string().min(1).default("us-east-1"),
  DDB_ENDPOINT: z.string().url().optional(),
  DDB_TABLE_PREFIX: z.string().min(1).default("chaperone"),
  HOUSEHOLD_ID: z.string().min(1).default("household-demo"),
  CHAPERONE_UPSTREAMS: upstreamsField,
  // Two separate model ids, not one shared BEDROCK_MODEL_ID: advisory
  // scoring (packages/advisory/src/scoreDiff.ts) and baseline 2
  // (packages/eval/src/baseline-model.ts) are deliberately different
  // Bedrock calls answering different questions, so they are separately
  // configurable rather than forced to move together. Both are consumed by
  // the same BedrockModelProvider (packages/advisory/src/providers/bedrock.ts)
  // — the model id, not the provider class, is what differs. Amazon Nova
  // Lite/Nova Pro are the decided defaults for this project (see
  // docs/AWS-BUILDER.md); Claude Haiku 4.5 via Bedrock remains a documented,
  // swappable-by-config alternative, never hard-coded here.
  ADVISORY_MODEL_ID: z.string().min(1).optional(),
  BASELINE_MODEL_ID: z.string().min(1).optional(),
  GITHUB_TOKEN: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PORT: z.coerce.number().int().positive().default(3000),
  // Comma-separated. A trailing ":*" on an entry matches any port on that
  // origin, so the default covers every localhost dev port without an
  // operator having to list each one.
  GATEWAY_ORIGIN_ALLOWLIST: originAllowlistField,
  BIND_ALL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Phase 11: the master switch for the MCP App consent card. "false"
  // forces every refusal down the text-only path regardless of what a
  // client declares at initialize — the escape hatch for a host whose
  // ext-apps implementation turns out to be broken on demo day, per
  // docs/DECISIONS.md's "Fallback if the handshake costs more than
  // projected."
  MCP_APP_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Phase 16: what /healthz reports about the running build. Both are
  // baked into the image at build time (docker/gateway.Dockerfile) rather
  // than discovered at runtime — a container has no .git directory, and a
  // commit the process guessed would be worse than one it admits it does
  // not know. "unknown" is the honest default and /healthz prints it.
  CHAPERONE_VERSION: z.string().min(1).default("0.0.0"),
  CHAPERONE_COMMIT: z.string().min(1).default("unknown"),
  // Phase 17: gates HSTS (Strict-Transport-Security is a lie on a plain-HTTP
  // local/demo deployment — sending it there would tell a browser to
  // upgrade every future request to a host that may not even terminate
  // TLS) and nothing else. Not a general feature-flag switch.
  CHAPERONE_ENV: z.enum(["development", "production"]).default("development"),
});

export interface Config {
  awsRegion: string;
  ddbEndpoint?: string;
  ddbTablePrefix: string;
  householdId: string;
  upstreams: UpstreamConfig[];
  advisoryModelId?: string;
  baselineModelId?: string;
  githubToken?: string;
  logLevel: string;
  port: number;
  originAllowlist: string[];
  bindAll: boolean;
  mcpAppEnabled: boolean;
  version: string;
  commit: string;
  env: "development" | "production";
}

const EXPECTED_SHAPE: Record<string, string> = {
  AWS_REGION: 'string (default "us-east-1")',
  DDB_ENDPOINT: 'string URL, optional (e.g. "http://localhost:8000")',
  DDB_TABLE_PREFIX: 'string (default "chaperone")',
  HOUSEHOLD_ID: 'string (default "household-demo")',
  CHAPERONE_UPSTREAMS: "JSON array of {id: string, url: string, label: string}",
  ADVISORY_MODEL_ID: "string, optional (Bedrock model/inference-profile id for advisory diff scoring)",
  BASELINE_MODEL_ID: "string, optional (Bedrock model/inference-profile id for eval baseline 2)",
  GITHUB_TOKEN: "string, optional",
  LOG_LEVEL: 'one of "fatal" | "error" | "warn" | "info" | "debug" | "trace" (default "info")',
  PORT: "positive integer (default 3000)",
  GATEWAY_ORIGIN_ALLOWLIST: 'comma-separated origins, e.g. "http://localhost:*,https://app.example.com" (default "http://localhost:*")',
  BIND_ALL: 'one of "true" | "false" (default "false")',
  MCP_APP_ENABLED: 'one of "true" | "false" (default "true")',
  CHAPERONE_VERSION: 'string (default "0.0.0")',
  CHAPERONE_COMMIT: 'string, the full git sha of the running build (default "unknown")',
  CHAPERONE_ENV: 'one of "development" | "production" (default "development")',
};

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    const shape = EXPECTED_SHAPE[key] ?? "unknown";
    return `  ${key}: expected ${shape} — ${issue.message}`;
  });
  return `Invalid environment configuration:\n${lines.join("\n")}`;
}

let cachedConfig: Config | undefined;

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error), { issues: result.error.issues });
  }

  const env = result.data;

  cachedConfig = {
    awsRegion: env.AWS_REGION,
    ddbTablePrefix: env.DDB_TABLE_PREFIX,
    householdId: env.HOUSEHOLD_ID,
    upstreams: env.CHAPERONE_UPSTREAMS,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    originAllowlist: env.GATEWAY_ORIGIN_ALLOWLIST,
    bindAll: env.BIND_ALL,
    mcpAppEnabled: env.MCP_APP_ENABLED,
    version: env.CHAPERONE_VERSION,
    commit: env.CHAPERONE_COMMIT,
    env: env.CHAPERONE_ENV,
    ...(env.DDB_ENDPOINT !== undefined ? { ddbEndpoint: env.DDB_ENDPOINT } : {}),
    ...(env.ADVISORY_MODEL_ID !== undefined ? { advisoryModelId: env.ADVISORY_MODEL_ID } : {}),
    ...(env.BASELINE_MODEL_ID !== undefined ? { baselineModelId: env.BASELINE_MODEL_ID } : {}),
    ...(env.GITHUB_TOKEN !== undefined ? { githubToken: env.GITHUB_TOKEN } : {}),
  };

  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}
