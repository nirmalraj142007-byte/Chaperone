import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { TABLE_SCHEMAS, type TableLogicalName } from "@chaperone/ledger";
import { TABLE_PREFIX } from "./tables-stack.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_DIR = path.join(HERE, "..", "..", "deploy");

/**
 * The exact DynamoDB actions the gateway's repos issue, per table, read off
 * packages/ledger/src/repos/* and the `ledger.*` calls in packages/gateway/src.
 * `ledger-event` has no Update/Delete on purpose: CLAUDE.md non-negotiable 6,
 * enforced here by IAM and not only by the repo layer. `advisory` is read-only
 * (the gateway looks an advisory up for the card; the pipeline writes it).
 * corpus-server, tool-snapshot and drift-record are written by the crawler and
 * analysis, which run locally, so the instance role gets nothing on them.
 */
const GATEWAY_GRANTS: Partial<Record<TableLogicalName, readonly string[]>> = {
  pin: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
  "ledger-event": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
  quarantine: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
  advisory: ["dynamodb:GetItem"],
  session: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
  "sse-event": ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
};

/** Pinned; fetched once at first boot. Bump deliberately. */
const COMPOSE_VERSION = "v2.29.7";

export interface Ec2GatewayStackProps extends StackProps {
  repository: ecr.IRepository;
  /** The staged demo upstream's image, run beside the gateway on the same host. */
  demoRepository: ecr.IRepository;
  householdId?: string;
}

/**
 * One small EC2 instance running the gateway, the staged demo upstream and
 * Caddy under Docker Compose. No load balancer, no ACM and no NAT (the
 * reasoning is in docs/RUNBOOK.md). Caddy obtains and renews its own
 * certificate for `DomainName`. Only Caddy publishes ports, and it routes to
 * the gateway alone: the demo upstream's unauthenticated /control routes stay
 * on the internal compose network (asserted in infra/test).
 *
 * The stack builds the host and does not deploy the application. The image
 * is rolled out and rolled back by `/opt/chaperone/deploy.sh <sha>` over SSM
 * (RUNBOOK), so a new image never requires touching CloudFormation or
 * replacing the instance. Pausing is `aws ec2 stop-instances`; the Elastic IP
 * and Route 53 record are part of the stack so DNS survives a stop/start.
 *
 * Holds no data: the tables live in TablesStack and are addressed by
 * name-derived ARN, so this stack can be destroyed and redeployed freely.
 */
export class Ec2GatewayStack extends Stack {
  constructor(scope: Construct, id: string, props: Ec2GatewayStackProps) {
    super(scope, id, props);

    const householdId = props.householdId ?? "household-demo";

    // --- Parameters: values supplied at deploy time ---------------------------

    const domainName = new CfnParameter(this, "DomainName", {
      type: "String",
      description: "Public hostname for the gateway, e.g. gateway.example.com. Must sit inside the hosted zone below.",
      allowedPattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
      constraintDescription: "must be a lowercase DNS hostname",
    });
    const hostedZoneId = new CfnParameter(this, "HostedZoneId", {
      type: "AWS::Route53::HostedZone::Id",
      description: "Route 53 hosted zone that contains DomainName. The A record to the Elastic IP is written here.",
    });
    const hostedZoneName = new CfnParameter(this, "HostedZoneName", {
      type: "String",
      description: "The hosted zone's name, e.g. example.com.",
    });
    const upstreamsJson = new CfnParameter(this, "UpstreamsJson", {
      type: "String",
      // The demo upstream running on this host, reached over the compose network by service name.
      default: '[{"id":"grocery","url":"http://demo-upstream:4000/mcp","label":"Household Grocery"}]',
      // Must not contain a single quote: it is written into a single-quoted .env value.
      allowedPattern: "^[^']*$",
      description: 'CHAPERONE_UPSTREAMS: JSON array of {"id","url","label"}. Defaults to the demo upstream on this host.',
    });
    const instanceType = new CfnParameter(this, "InstanceType", {
      type: "String",
      default: "t3.micro",
      allowedValues: ["t3.micro", "t3.small", "t3.medium"],
      description: "x86 only: the image is built for linux/amd64. t3.micro is the smallest that fits; use t3.small if the account's free tier does not cover t3.micro.",
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: hostedZoneId.valueAsString,
      zoneName: hostedZoneName.valueAsString,
    });

    // --- Network: one public subnet, no NAT -----------------------------------

    const vpc = new ec2.Vpc(this, "Vpc", {
      // Resolved by CloudFormation (Fn::GetAZs) rather than a synth-time lookup,
      // so `cdk synth` needs no AWS credentials.
      availabilityZones: [Fn.select(0, Fn.getAzs(this.region))],
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const sg = new ec2.SecurityGroup(this, "HostSg", {
      vpc,
      description: "Chaperone host: HTTP/HTTPS only. No SSH; shell access is SSM Session Manager.",
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "ACME HTTP-01 and the redirect to HTTPS");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(443), "HTTP/3");

    // --- Logs: CloudWatch, 30 days. Cheap at this volume (RUNBOOK, Cost). ------

    const logGroup = new logs.LogGroup(this, "GatewayLogs", {
      logGroupName: "/chaperone/gateway",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Instance role: least privilege -----------------------------------------

    const role = new iam.Role(this, "HostRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Chaperone gateway host",
      // Session Manager + Run Command, instead of opening port 22.
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });

    for (const schema of TABLE_SCHEMAS) {
      const actions = GATEWAY_GRANTS[schema.logicalName];
      if (actions === undefined) continue;
      const arn = this.formatArn({ service: "dynamodb", resource: "table", resourceName: `${TABLE_PREFIX}-${schema.logicalName}` });
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: `Gateway${schema.logicalName.replace(/[^A-Za-z0-9]/g, "")}`,
          actions: [...actions],
          resources: schema.gsi ? [arn, `${arn}/index/*`] : [arn],
        }),
      );
    }
    props.repository.grantPull(role);
    props.demoRepository.grantPull(role);
    logGroup.grantWrite(role);

    // --- First-boot script: install Docker, lay down /opt/chaperone ---------------
    //
    // Installs and prepares; it does NOT start the gateway. No image is
    // deployed until `deploy.sh <sha>` runs (RUNBOOK), so a first boot never
    // fails on an image that does not exist yet.

    // LF only: a CRLF checkout on Windows would put \r into the scripts and break them under bash on the host.
    const read = (name: string): string => fs.readFileSync(path.join(DEPLOY_DIR, name), "utf8").replace(/\r\n/g, "\n");
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "dnf install -y docker",
      "systemctl enable --now docker",
      // 1 GB of RAM is enough for the gateway and Caddy; swap is cheap insurance against an OOM kill.
      "fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab",
      "mkdir -p /usr/local/lib/docker/cli-plugins /opt/chaperone",
      `curl -fsSL https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose`,
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",
      "cat > /opt/chaperone/docker-compose.yml <<'CHAPERONE_EOF'\n" + read("docker-compose.yml") + "CHAPERONE_EOF",
      "cat > /opt/chaperone/Caddyfile <<'CHAPERONE_EOF'\n" + read("Caddyfile") + "CHAPERONE_EOF",
      "cat > /opt/chaperone/deploy.sh <<'CHAPERONE_EOF'\n" + read("deploy.sh") + "CHAPERONE_EOF",
      "cat > /opt/chaperone/demo-control.sh <<'CHAPERONE_EOF'\n" + read("demo-control.sh") + "CHAPERONE_EOF",
      "chmod 755 /opt/chaperone/deploy.sh /opt/chaperone/demo-control.sh",
      // Values only, no secrets: the role supplies every credential.
      "cat > /opt/chaperone/.env <<'CHAPERONE_EOF'\n" +
        [
          "COMPOSE_PROJECT_NAME=chaperone",
          `AWS_REGION=${this.region}`,
          `ECR_REPO=${props.repository.repositoryUri}`,
          `DEMO_ECR_REPO=${props.demoRepository.repositoryUri}`,
          `GATEWAY_IMAGE=${props.repository.repositoryUri}:unset`,
          `DEMO_UPSTREAM_IMAGE=${props.demoRepository.repositoryUri}:unset`,
          `HOUSEHOLD_ID=${householdId}`,
          `CADDY_SITE=${domainName.valueAsString}`,
          `GATEWAY_ORIGIN_ALLOWLIST=https://${domainName.valueAsString}`,
          `CHAPERONE_UPSTREAMS='${upstreamsJson.valueAsString}'`,
        ].join("\n") +
        "\nCHAPERONE_EOF",
      "chmod 600 /opt/chaperone/.env",
    );

    // --- The instance ----------------------------------------------------------------

    const instance = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(instanceType.valueAsString),
      // Resolved from an SSM public parameter by CloudFormation: no synth-time lookup.
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 }),
      securityGroup: sg,
      role,
      userData,
      associatePublicIpAddress: true,
      blockDevices: [
        { deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }) },
      ],
    });
    // IMDSv2 required, with a hop limit of 2. The default of 1 would stop the
    // gateway *container* from reaching the instance role's credentials through
    // Docker's bridge, and every DynamoDB call would then fail closed.
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.metadataOptions = { httpEndpoint: "enabled", httpTokens: "required", httpPutResponseHopLimit: 2 };

    // --- Stable address: an Elastic IP, so DNS survives stop/start ---------------------

    const eip = new ec2.CfnEIP(this, "Eip", { domain: "vpc", instanceId: instance.instanceId });

    new route53.ARecord(this, "Record", {
      zone,
      recordName: domainName.valueAsString,
      target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
      ttl: Duration.seconds(60),
    });

    new CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new CfnOutput(this, "ElasticIp", { value: eip.attrPublicIp });
    new CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName });
    new CfnOutput(this, "RepositoryUri", { value: props.repository.repositoryUri });
    new CfnOutput(this, "DemoRepositoryUri", { value: props.demoRepository.repositoryUri });
  }
}
