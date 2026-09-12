import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { loadConfig } from "@chaperone/config";

let cachedClient: DynamoDBDocumentClient | undefined;

/**
 * Lazily constructs the one DynamoDB document client this process ever
 * uses, memoised after the first call. Lazy rather than eager at module
 * load so `@chaperone/config`'s own env validation runs at first real use
 * (a script's entry point, a request handler) rather than at import time,
 * where required env vars may not be set yet (e.g. under test).
 */
export function getDdbDocClient(): DynamoDBDocumentClient {
  if (cachedClient === undefined) {
    const config = loadConfig();
    const baseClient = new DynamoDBClient({
      region: config.awsRegion,
      ...(config.ddbEndpoint !== undefined
        ? {
            endpoint: config.ddbEndpoint,
            // DynamoDB Local ignores these, but the SDK v3 credential
            // resolver still requires *something* present before it will
            // construct a client — real AWS credentials are never read on
            // this path.
            credentials: { accessKeyId: "local", secretAccessKey: "local" },
          }
        : {}),
    });
    cachedClient = DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return cachedClient;
}

export function resetDdbClientForTests(): void {
  cachedClient = undefined;
}
