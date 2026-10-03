/**
 * infra/iam-advisory.json is a policy DOCUMENT, not a deployed role —
 * deployment (Phase 18) hasn't started, so there is no live AWS account or
 * IAM role to audit. This test is the audit CLAUDE.md's non-negotiable #6
 * (the ledger is append-only, no UpdateItem/DeleteItem, IAM denies them in
 * production) and this phase's own instruction ("assert in a test that the
 * model-calling role's action list contains no write verb against the
 * ledger-event, pin, or quarantine tables") actually have behind them,
 * rather than being claims with nothing checking them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TABLE_LOGICAL_NAMES } from "../src/tables.js";

// packages/ledger/test/iam-advisory.test.ts -> packages/ledger/test -> packages/ledger -> packages -> repo root.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const POLICY_PATH = path.join(REPO_ROOT, "infra", "iam-advisory.json");

const DYNAMODB_WRITE_VERBS = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems"];

interface Statement {
  sid: string;
  effect: "Allow" | "Deny";
  actions: string[];
  resources: string[];
}

interface Role {
  name: string;
  description: string;
  statements: Statement[];
}

interface PolicyDoc {
  roles: Role[];
}

function loadPolicy(): PolicyDoc {
  return JSON.parse(readFileSync(POLICY_PATH, "utf8")) as PolicyDoc;
}

function tableArnFragment(logicalName: string): string {
  return `table/chaperone-${logicalName}`;
}

describe("infra/iam-advisory.json", () => {
  it("parses as valid JSON with at least a gateway role and a model-calling role", () => {
    const policy = loadPolicy();
    expect(policy.roles.length).toBeGreaterThanOrEqual(2);
    expect(policy.roles.map((r) => r.name)).toContain("chaperone-model-advisory-role");
  });

  it("every table name referenced anywhere in the policy is a real logical table name, current prefix", () => {
    const policy = loadPolicy();
    const raw = JSON.stringify(policy);
    // Every "table/chaperone-<logical>" fragment the doc contains must name
    // a table packages/ledger/src/tables.ts actually knows about — if
    // either the prefix or a table were renamed and this file weren't
    // updated, this fails instead of silently auditing a policy that no
    // longer matches what's deployed.
    const found = [...raw.matchAll(/table\/chaperone-([a-z-]+?)(?:"|\/)/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(0);
    for (const name of found) {
      expect(TABLE_LOGICAL_NAMES as readonly string[]).toContain(name);
    }
  });

  it("the model-calling role's action list contains no DynamoDB write verb at all", () => {
    const policy = loadPolicy();
    const modelRole = policy.roles.find((r) => r.name === "chaperone-model-advisory-role");
    expect(modelRole).toBeDefined();
    const allActions = modelRole!.statements.flatMap((s) => s.actions);
    for (const verb of DYNAMODB_WRITE_VERBS) {
      expect(allActions).not.toContain(verb);
    }
  });

  it("the model-calling role's action list contains no write verb against ledger-event, pin, or quarantine specifically", () => {
    const policy = loadPolicy();
    const modelRole = policy.roles.find((r) => r.name === "chaperone-model-advisory-role");
    const protectedTables = ["ledger-event", "pin", "quarantine"];
    for (const statement of modelRole!.statements) {
      const touchesProtectedTable = statement.resources.some((resource) =>
        protectedTables.some((t) => resource.includes(tableArnFragment(t))),
      );
      if (!touchesProtectedTable) {
        continue;
      }
      for (const verb of DYNAMODB_WRITE_VERBS) {
        expect(statement.actions).not.toContain(verb);
      }
    }
  });

  it("the model-calling role has no statement naming ledger-event or pin at all — not even read access", () => {
    const policy = loadPolicy();
    const modelRole = policy.roles.find((r) => r.name === "chaperone-model-advisory-role");
    const allResources = modelRole!.statements.flatMap((s) => s.resources).join(" ");
    expect(allResources).not.toContain(tableArnFragment("ledger-event"));
    expect(allResources).not.toContain(tableArnFragment("pin"));
  });

  it("the model-calling role can read exactly one secret and call no Bedrock action", () => {
    const policy = loadPolicy();
    const modelRole = policy.roles.find((r) => r.name === "chaperone-model-advisory-role");
    const actions = modelRole!.statements.flatMap((s) => s.actions);
    expect(actions.filter((a) => a.startsWith("bedrock:"))).toEqual([]);
    const secretStatements = modelRole!.statements.filter((s) => s.actions.some((a) => a.startsWith("secretsmanager:")));
    expect(secretStatements).toHaveLength(1);
    expect(secretStatements[0]!.actions.sort()).toEqual(["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]);
    expect(secretStatements[0]!.resources).toEqual(["arn:aws:secretsmanager:*:*:secret:chaperone/groq-api-key-*"]);
  });

  it("the changelog-check role has no write verb, no secret and no model access, and reads only quarantine and pin", () => {
    const policy = loadPolicy();
    const role = policy.roles.find((r) => r.name === "chaperone-changelog-check-role");
    expect(role).toBeDefined();
    const actions = role!.statements.flatMap((s) => s.actions);
    for (const verb of DYNAMODB_WRITE_VERBS) {
      expect(actions).not.toContain(verb);
    }
    expect(actions.filter((a) => a.startsWith("secretsmanager:") || a.startsWith("bedrock:"))).toEqual([]);
    const resources = role!.statements.flatMap((s) => s.resources).join(" ");
    expect(resources).not.toContain(tableArnFragment("ledger-event"));
    expect(resources).not.toContain(tableArnFragment("advisory"));
    expect(resources).toContain(tableArnFragment("quarantine"));
    expect(resources).toContain(tableArnFragment("pin"));
  });

  it("the gateway role's ledger-event statement grants no write verb beyond PutItem — no UpdateItem, no DeleteItem, no BatchWriteItem", () => {
    const policy = loadPolicy();
    const gatewayRole = policy.roles.find((r) => r.name === "chaperone-gateway-task-role");
    expect(gatewayRole).toBeDefined();
    const ledgerStatement = gatewayRole!.statements.find((s) =>
      s.resources.some((r) => r.includes(tableArnFragment("ledger-event"))),
    );
    expect(ledgerStatement).toBeDefined();
    expect(ledgerStatement!.actions).toContain("dynamodb:PutItem");
    for (const verb of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems"]) {
      expect(ledgerStatement!.actions).not.toContain(verb);
    }
  });

  it("no statement anywhere in the document uses Effect: Deny — an advisory policy that relies on an explicit deny to hide an over-broad allow is the wrong shape", () => {
    const policy = loadPolicy();
    for (const role of policy.roles) {
      for (const statement of role.statements) {
        expect(statement.effect).toBe("Allow");
      }
    }
  });
});
