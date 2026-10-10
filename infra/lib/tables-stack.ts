import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { TABLE_SCHEMAS, type KeyAttribute } from "@chaperone/ledger";

/** Same literal, same reason, as advisory-pipeline-stack.ts: synth must not depend on a runtime env. */
export const TABLE_PREFIX = "chaperone";

/**
 * Owned by AdvisoryPipelineStack (it needs their DynamoDB stream). Creating
 * them here too would fail on the duplicate physical name.
 */
const OWNED_BY_ADVISORY_STACK = ["quarantine", "advisory"];

function attributeType(type: KeyAttribute["type"]): dynamodb.AttributeType {
  return type === "S" ? dynamodb.AttributeType.STRING : dynamodb.AttributeType.NUMBER;
}

function keyAttribute(key: KeyAttribute): dynamodb.Attribute {
  return { name: key.name, type: attributeType(key.type) };
}

/**
 * The 7 tables built from `TABLE_SCHEMAS` (packages/ledger/src/schema.ts),
 * so this stack and `pnpm ddb:migrate` can never describe different keys.
 *
 * Separate from GatewayStack so the gateway can be destroyed and redeployed
 * (the pause between 2026-10-22 and 2026-11-07, docs/RUNBOOK.md) without
 * touching the data. Every table is RemovalPolicy.RETAIN: `cdk destroy` of
 * this stack would orphan them, not delete them, and a redeploy would then
 * fail on the name collision. Do not destroy this stack. The ledger is the
 * evidence chain; deleting it is a deliberate manual step (RUNBOOK, Teardown).
 */
export class TablesStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    for (const schema of TABLE_SCHEMAS) {
      if (OWNED_BY_ADVISORY_STACK.includes(schema.logicalName)) continue;

      const [pk, sk] = schema.keys;
      const table = new dynamodb.Table(this, `Table-${schema.logicalName}`, {
        tableName: `${TABLE_PREFIX}-${schema.logicalName}`,
        partitionKey: keyAttribute(pk),
        ...(sk ? { sortKey: keyAttribute(sk) } : {}),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        ...(schema.ttlAttribute !== undefined ? { timeToLiveAttribute: schema.ttlAttribute } : {}),
        // The ledger and pins are evidence; point-in-time recovery is cheap insurance for those two only.
        ...(schema.logicalName === "ledger-event" || schema.logicalName === "pin"
          ? { pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true } }
          : {}),
        removalPolicy: RemovalPolicy.RETAIN,
      });
      if (schema.gsi) {
        table.addGlobalSecondaryIndex({
          indexName: schema.gsi.indexName,
          partitionKey: keyAttribute(schema.gsi.keys[0]),
          sortKey: keyAttribute(schema.gsi.keys[1]),
        });
      }
    }
  }
}
