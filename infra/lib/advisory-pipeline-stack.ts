import path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as pipes from "aws-cdk-lib/aws-pipes";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { TABLE_SCHEMAS, type KeyAttribute, type TableSchema } from "@chaperone/ledger";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Matches `@chaperone/config`'s `DDB_TABLE_PREFIX` default
 * (`packages/config/src/index.ts`) and what `docker-compose.yml` sets for
 * every local/demo run. Not read from `loadConfig()` at synth time — this
 * stack must `cdk synth` with no runtime env present at all (no
 * `CHAPERONE_UPSTREAMS`, no AWS credentials), so it takes the same default
 * as a literal instead of depending on the full env schema loading
 * successfully just to synthesize.
 */
const TABLE_PREFIX = "chaperone";

/**
 * A CHAPERONE_UPSTREAMS placeholder for both Lambdas' environment — neither
 * function ever calls an upstream MCP server, but `@chaperone/ledger`'s
 * `getDdbDocClient()` calls `@chaperone/config`'s `loadConfig()` internally
 * (`packages/ledger/src/client.ts`), which requires `CHAPERONE_UPSTREAMS` to
 * parse regardless of which repo function actually needs it. A genuinely
 * unused, schema-valid placeholder is honest about that coupling rather
 * than working around it by hand-rolling a second DynamoDB client
 * constructor for just these two functions.
 */
const UNUSED_UPSTREAMS_PLACEHOLDER = JSON.stringify([
  { id: "unused", url: "http://localhost:0/mcp", label: "unused by the advisory pipeline Lambdas" },
]);

function attributeType(type: KeyAttribute["type"]): dynamodb.AttributeType {
  return type === "S" ? dynamodb.AttributeType.STRING : dynamodb.AttributeType.NUMBER;
}

function keyAttribute(key: KeyAttribute): dynamodb.Attribute {
  return { name: key.name, type: attributeType(key.type) };
}

function findTableSchema(logicalName: string): TableSchema {
  const schema = TABLE_SCHEMAS.find((s) => s.logicalName === logicalName);
  if (!schema) {
    throw new Error(`no TABLE_SCHEMAS entry named "${logicalName}" (packages/ledger/src/schema.ts)`);
  }
  return schema;
}

export interface AdvisoryPipelineStackProps extends StackProps {
  /** Single hardcoded household, per CLAUDE.md's "out of scope: multi-tenancy... one household, one resident identity." */
  householdId?: string;
  /** Model id on Groq. Default openai/gpt-oss-120b, an open-weight model served by Groq. */
  advisoryModelId?: string;
  /**
   * Name of the Secrets Manager secret holding the Groq key. The stack only
   * references it; it never creates it, so no key value can enter the template.
   * Create it out of band: `aws secretsmanager create-secret --name chaperone/groq-api-key --secret-string ...`.
   */
  groqSecretName?: string;
  /** upstreamId -> GitHub repo, for the changelog-check branch. An upstream not listed gets `unresolved`, never `none`. */
  upstreamRepos?: Record<string, { owner: string; repo: string }>;
}

/**
 * AWS-01: DynamoDB Stream -> EventBridge Pipe -> Step Functions -> Lambdas
 * -> advisory table. `cdk synth` only this phase — CLAUDE.md's Phase 18 is
 * the actual `cdk deploy`; nothing here has ever been applied to an AWS
 * account. See docs/AWS-BUILDER.md, "AWS-01: the Step Functions pipeline,"
 * for the local `pnpm advisory:run-local` stand-in this replaces once
 * deployed.
 *
 * Table ownership note: `chaperone-quarantine` and `chaperone-advisory` are
 * defined here as CDK-managed resources (mirroring
 * `packages/ledger/src/schema.ts` exactly, so the two can never drift) —
 * this is new for the project. Every other table, and both of these tables
 * for local/`DDB_ENDPOINT`-pointed dev, is still created imperatively by
 * `packages/ledger/scripts/migrate.ts` against DynamoDB Local, completely
 * unaffected by this stack. This is the Phase 18 migration path for a real
 * deployed environment (CDK becomes the source of truth for the *deployed*
 * copies of these two tables, since the stream this pipeline needs can only
 * exist on a table CDK provisions and owns); `migrate.ts`'s own
 * `tableExists` guard makes it a harmless no-op if ever pointed at an
 * environment where this stack has already created them.
 */
export class AdvisoryPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: AdvisoryPipelineStackProps = {}) {
    super(scope, id, props);

    const householdId = props.householdId ?? "household-demo";
    const advisoryModelId = props.advisoryModelId ?? "openai/gpt-oss-120b";
    const groqSecretName = props.groqSecretName ?? "chaperone/groq-api-key";
    const upstreamRepos = props.upstreamRepos ?? {};

    // --- Tables -----------------------------------------------------------

    const quarantineSchema = findTableSchema("quarantine");
    const quarantineTable = new dynamodb.Table(this, "QuarantineTable", {
      tableName: `${TABLE_PREFIX}-quarantine`,
      partitionKey: keyAttribute(quarantineSchema.keys[0]),
      ...(quarantineSchema.keys[1] ? { sortKey: keyAttribute(quarantineSchema.keys[1]) } : {}),
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // The one property this stack needs that migrate.ts's imperative
      // CreateTableCommand never sets — a stream is what the EventBridge
      // Pipe below sources from. NEW_IMAGE only: the pipe's filter and
      // input template both read out of NewImage, never OldImage.
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    if (quarantineSchema.gsi) {
      quarantineTable.addGlobalSecondaryIndex({
        indexName: quarantineSchema.gsi.indexName,
        partitionKey: keyAttribute(quarantineSchema.gsi.keys[0]),
        sortKey: keyAttribute(quarantineSchema.gsi.keys[1]),
      });
    }

    const advisorySchema = findTableSchema("advisory");
    const advisoryTable = new dynamodb.Table(this, "AdvisoryTable", {
      tableName: `${TABLE_PREFIX}-advisory`,
      partitionKey: keyAttribute(advisorySchema.keys[0]),
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const sharedLambdaEnv = {
      CHAPERONE_UPSTREAMS: UNUSED_UPSTREAMS_PLACEHOLDER,
      DDB_TABLE_PREFIX: TABLE_PREFIX,
      HOUSEHOLD_ID: householdId,
    };

    // --- ScoreAdvisory Lambda: Groq call + read-only quarantine ------------
    //
    // Matches infra/iam-advisory.json's "chaperone-model-advisory-role"
    // exactly: read of ONE secret + GetItem/Query on chaperone-quarantine only.
    // No DynamoDB write action anywhere on this function's role � audited
    // by packages/ledger/test/iam-advisory.test.ts against that same JSON
    // document, which this stack's grants are written to match.
    //
    // The Groq key is not in this template. The secret is referenced by name
    // (`fromSecretNameV2`), and the function reads its value at runtime.

    const groqSecret = secretsmanager.Secret.fromSecretNameV2(this, "GroqApiKeySecret", groqSecretName);

    const scoreAdvisoryFn = new NodejsFunction(this, "ScoreAdvisoryFunction", {
      functionName: "chaperone-advisory-score",
      entry: path.join(HERE, "..", "lambda", "scoreAdvisory.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(25),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: { ...sharedLambdaEnv, ADVISORY_MODEL_ID: advisoryModelId, GROQ_SECRET_ARN: groqSecret.secretArn },
    });

    groqSecret.grantRead(scoreAdvisoryFn);
    quarantineTable.grantReadData(scoreAdvisoryFn);

    // --- ChangelogCheck Lambda: no model, read-only ------------------------
    //
    // The parallel branch. Reads the quarantine and the pin it replaces (for the
    // date the household approved the old definition), then asks GitHub whether
    // the vendor published any release, tag or commit in that window. GetItem
    // on those two tables and nothing else: no write verb, no secret, no model.
    // The pin table is not CDK-managed in this stack, so its ARN is built from
    // the table prefix; infra/iam-advisory.json carries the same statement.

    const changelogFn = new NodejsFunction(this, "ChangelogCheckFunction", {
      functionName: "chaperone-advisory-changelog",
      entry: path.join(HERE, "..", "lambda", "changelogCheck.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(25),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        ...sharedLambdaEnv,
        UPSTREAM_REPOS: JSON.stringify(upstreamRepos),
        // Lambda's filesystem is read-only outside /tmp; githubClient.ts caches there.
        ADVISORY_GITHUB_CACHE_DIR: "/tmp/github-cache",
      },
    });
    quarantineTable.grantReadData(changelogFn);
    changelogFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadPinForApprovalDate",
        actions: ["dynamodb:GetItem"],
        resources: [this.formatArn({ service: "dynamodb", resource: "table", resourceName: `${TABLE_PREFIX}-pin` })],
      }),
    );

    // --- WriteAdvisory Lambda: PutItem on chaperone-advisory only ----------
    //
    // No model or secret permission, no access to chaperone-ledger-event or
    // chaperone-pin, and — unlike the scoring role above — this one *can*
    // write, but only to chaperone-advisory. Splitting scoring and writing
    // into separate functions under separate roles is what makes "the
    // Bedrock-calling Lambda has zero DynamoDB write permission" true
    // without also meaning "the pipeline can't write its own result."

    const writeAdvisoryFn = new NodejsFunction(this, "WriteAdvisoryFunction", {
      functionName: "chaperone-advisory-write",
      entry: path.join(HERE, "..", "lambda", "writeAdvisory.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(15),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: sharedLambdaEnv,
    });
    // Exactly GetItem (the idempotency check) + PutItem — not
    // grantReadWriteData(), which would also hand this role UpdateItem,
    // DeleteItem, and BatchWriteItem it never calls.
    advisoryTable.grant(writeAdvisoryFn, "dynamodb:GetItem", "dynamodb:PutItem");

    // --- Step Functions: Parallel(score, changelog) -> (scored? write : no-op)

    const scoreTask = new tasks.LambdaInvoke(this, "ScoreAdvisoryTask", {
      lambdaFunction: scoreAdvisoryFn,
      payloadResponseOnly: true,
    });

    const changelogTask = new tasks.LambdaInvoke(this, "ChangelogCheckTask", {
      lambdaFunction: changelogFn,
      payloadResponseOnly: true,
    });
    // The changelog branch is a decoration on a decoration: if its Lambda errors,
    // the score must still be written, so the failure becomes an `unresolved` result.
    changelogTask.addCatch(
      new sfn.Pass(this, "ChangelogCheckFailed", {
        result: sfn.Result.fromObject({ status: "unresolved", reason: "changelog-lambda-error" }),
      }),
      { resultPath: sfn.JsonPath.DISCARD },
    );

    const parallel = new sfn.Parallel(this, "ScoreAndCheckChangelog", {
      comment: "The model branch and the no-model branch run at the same time; the join is an array [score, changelog].",
    })
      .branch(scoreTask)
      .branch(changelogTask);

    const writeTask = new tasks.LambdaInvoke(this, "WriteAdvisoryTask", {
      lambdaFunction: writeAdvisoryFn,
      payloadResponseOnly: true,
    });

    const noAdvisory = new sfn.Succeed(this, "AdvisoryUnavailable", {
      comment: "scoreDiff returned unavailable � the quarantined tool is rendered without an advisory, per its own contract. Never treated as a pipeline failure. The changelog result is in this execution's output but is not written without a score.",
    });

    const definition = parallel.next(
      new sfn.Choice(this, "WasScored")
        .when(sfn.Condition.stringEquals("$[0].status", "scored"), writeTask)
        .otherwise(noAdvisory),
    );

    const stateMachine = new sfn.StateMachine(this, "AdvisoryPipelineStateMachine", {
      stateMachineName: "chaperone-advisory-pipeline",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.minutes(2),
    });

    // --- EventBridge Pipe: chaperone-quarantine stream -> state machine ----
    //
    // Filtered to INSERT only (a quarantine's status only ever moves
    // pending -> approved/refused, never back to pending — see
    // packages/ledger/src/repos/quarantine.ts's resolveQuarantine — so a
    // fresh, unreviewed quarantine is always an INSERT, never a MODIFY) and
    // to NewImage.status == "pending", so a household resolving an existing
    // quarantine never re-triggers advisory scoring.

    const pipeRole = new iam.Role(this, "AdvisoryPipeRole", {
      assumedBy: new iam.ServicePrincipal("pipes.amazonaws.com"),
    });
    quarantineTable.grantStreamRead(pipeRole);
    stateMachine.grantStartExecution(pipeRole);

    new pipes.CfnPipe(this, "AdvisoryPipe", {
      name: "chaperone-advisory-quarantine-pipe",
      roleArn: pipeRole.roleArn,
      source: quarantineTable.tableStreamArn!,
      sourceParameters: {
        dynamoDbStreamParameters: {
          startingPosition: "LATEST",
          batchSize: 1,
          maximumRetryAttempts: 3,
        },
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                eventName: ["INSERT"],
                dynamodb: { NewImage: { status: { S: ["pending"] } } },
              }),
            },
          ],
        },
      },
      target: stateMachine.stateMachineArn,
      targetParameters: {
        inputTemplate:
          '{"householdId": <$.dynamodb.NewImage.householdId.S>, "quarantineId": <$.dynamodb.NewImage.quarantineId.S>}',
        stepFunctionStateMachineParameters: {
          invocationType: "FIRE_AND_FORGET",
        },
      },
    });
  }
}
