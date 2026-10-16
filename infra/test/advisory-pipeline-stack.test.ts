import fs from "node:fs";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AdvisoryPipelineStack, LAMBDA_BUNDLING } from "../lib/advisory-pipeline-stack.js";

// Bundling skipped: these assertions are about the template, not the Lambda code.
const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
const stack = new AdvisoryPipelineStack(app, "Advisory", { env: { region: "us-east-1" } });
const template = Template.fromStack(stack);

/** The state machine's ASL, with the CloudFormation intrinsics replaced by placeholders. */
function definition(): { States: Record<string, { Type: string; InputPath?: string }> } {
  const machines = template.findResources("AWS::StepFunctions::StateMachine");
  const [machine] = Object.values(machines) as { Properties: { DefinitionString: { "Fn::Join": [string, unknown[]] } } }[];
  const parts = machine!.Properties.DefinitionString["Fn::Join"][1];
  return JSON.parse(parts.map((p) => (typeof p === "string" ? p : "ARN")).join("")) as ReturnType<typeof definition>;
}

describe("AdvisoryPipelineStack", () => {
  it("unwraps the Pipe's batch before the Lambdas see it", () => {
    // An EventBridge Pipe hands Step Functions an array even at batchSize 1.
    // Without this the pipeline "succeeded" on the first real deploy with
    // quarantineId undefined and no advisory written.
    const parallel = definition().States["ScoreAndCheckChangelog"];
    expect(parallel?.Type).toBe("Parallel");
    expect(parallel?.InputPath).toBe("$[0]");
    template.hasResourceProperties("AWS::Pipes::Pipe", {
      SourceParameters: { DynamoDBStreamParameters: { BatchSize: 1 } },
    });
  });

  it("aliases node:module to the shim in every Lambda bundle", () => {
    // jcs.ts's createRequire(import.meta.url) threw at module load in the
    // CommonJS bundle on the first real deploy; the shim is the fix.
    const shim = LAMBDA_BUNDLING.esbuildArgs["--alias:node:module"];
    expect(shim).toMatch(/node-module-shim\.ts$/);
    expect(fs.existsSync(shim)).toBe(true);
    const names = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((r) => (r as { Properties: { FunctionName?: string } }).Properties.FunctionName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("chaperone-advisory-"));
    expect(names.sort()).toEqual(["chaperone-advisory-changelog", "chaperone-advisory-score", "chaperone-advisory-write"]);
  });
});
