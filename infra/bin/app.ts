#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { AdvisoryPipelineStack } from "../lib/advisory-pipeline-stack.js";
import { Ec2GatewayStack } from "../lib/ec2-gateway-stack.js";
import { RegistryStack } from "../lib/registry-stack.js";
import { TablesStack } from "../lib/tables-stack.js";

const app = new App();

const account = process.env["CDK_DEFAULT_ACCOUNT"];
const env = {
  ...(account !== undefined ? { account } : {}),
  region: process.env["CDK_DEFAULT_REGION"] ?? "us-east-1",
};

new AdvisoryPipelineStack(app, "ChaperoneAdvisoryPipeline", { env });
new TablesStack(app, "ChaperoneTables");
const registry = new RegistryStack(app, "ChaperoneRegistry");
// The Tables, Registry and Gateway stacks take no `env`. Deliberately: with a concrete account/region, CDK validates the Vpc's
// AZs through an ec2:DescribeAvailabilityZones lookup at synth, so `cdk synth`
// would need AWS credentials. Env-agnostic, CloudFormation resolves the AZs at
// deploy time and the region is whatever the deploying credentials target
// (docs/RUNBOOK.md pins us-east-1 via AWS_REGION).
new Ec2GatewayStack(app, "ChaperoneGateway", { repository: registry.repository });
