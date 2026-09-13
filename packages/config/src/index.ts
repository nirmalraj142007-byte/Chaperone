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
  BEDROCK_MODEL_ID: z.string().min(1).optional(),
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
});

export interface Config {
  awsRegion: string;
  ddbEndpoint?: string;
  ddbTablePrefix: string;
  householdId: string;
  upstreams: UpstreamConfig[];
  bedrockModelId?: string;
  githubToken?: string;
  logLevel: string;
  port: number;
  originAllowlist: string[];
  bindAll: boolean;
}

const EXPECTED_SHAPE: Record<string, string> = {
  AWS_REGION: 'string (default "us-east-1")',
  DDB_ENDPOINT: 'string URL, optional (e.g. "http://localhost:8000")',
  DDB_TABLE_PREFIX: 'string (default "chaperone")',
  HOUSEHOLD_ID: 'string (default "household-demo")',
  CHAPERONE_UPSTREAMS: "JSON array of {id: string, url: string, label: string}",
  BEDROCK_MODEL_ID: "string, optional",
  GITHUB_TOKEN: "string, optional",
  LOG_LEVEL: 'one of "fatal" | "error" | "warn" | "info" | "debug" | "trace" (default "info")',
  PORT: "positive integer (default 3000)",
  GATEWAY_ORIGIN_ALLOWLIST: 'comma-separated origins, e.g. "http://localhost:*,https://app.example.com" (default "http://localhost:*")',
  BIND_ALL: 'one of "true" | "false" (default "false")',
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
    ...(env.DDB_ENDPOINT !== undefined ? { ddbEndpoint: env.DDB_ENDPOINT } : {}),
    ...(env.BEDROCK_MODEL_ID !== undefined ? { bedrockModelId: env.BEDROCK_MODEL_ID } : {}),
    ...(env.GITHUB_TOKEN !== undefined ? { githubToken: env.GITHUB_TOKEN } : {}),
  };

  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}
