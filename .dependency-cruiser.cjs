/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-llm-in-policy",
      severity: "error",
      comment:
        "packages/policy is the entire security property: a synchronous hash comparison. " +
        "No LLM or model-runtime client may ever enter its import graph.",
      from: { path: "^packages/policy" },
      to: {
        path: "client-bedrock-runtime|@anthropic-ai|^openai|@aws-sdk/client-sagemaker",
      },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make the module graph impossible to reason about.",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.base.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
