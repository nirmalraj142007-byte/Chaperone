#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { AdvisoryPipelineStack } from "../lib/advisory-pipeline-stack.js";

const app = new App();

const account = process.env["CDK_DEFAULT_ACCOUNT"];

new AdvisoryPipelineStack(app, "ChaperoneAdvisoryPipeline", {
  env: {
    ...(account !== undefined ? { account } : {}),
    region: process.env["CDK_DEFAULT_REGION"] ?? "us-east-1",
  },
});
