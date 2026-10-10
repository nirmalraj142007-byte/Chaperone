import { CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { TABLE_SCHEMAS, type TableLogicalName } from "@chaperone/ledger";
import { TABLE_PREFIX } from "./tables-stack.js";

const CONTAINER_PORT = 3000;

/**
 * The exact DynamoDB actions the gateway's repos issue, per table, read off
 * packages/ledger/src/repos/* and the `ledger.*` calls in packages/gateway/src.
 * `ledger-event` has no Update/Delete on purpose: CLAUDE.md non-negotiable 6,
 * enforced here by IAM and not only by the repo layer. `advisory` is read-only
 * (the gateway looks an advisory up for the card; the pipeline writes it).
 * corpus-server, tool-snapshot and drift-record are written by the crawler and
 * analysis, which run locally, so the task role gets nothing on them.
 */
const GATEWAY_GRANTS: Partial<Record<TableLogicalName, readonly string[]>> = {
  pin: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
  "ledger-event": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
  quarantine: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
  advisory: ["dynamodb:GetItem"],
  session: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
  "sse-event": ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
};

export interface GatewayStackProps extends StackProps {
  repository: ecr.IRepository;
  householdId?: string;
}

/**
 * ECS Fargate + ALB, not App Runner: App Runner caps request duration at
 * 120s and resumable SSE is the flagship claim (CLAUDE.md, "Deliberate
 * choices").
 *
 * Built to be destroyed and redeployed (the pause after 2026-10-22):
 * nothing here holds data or has a RETAIN policy, the tables live in
 * TablesStack and are addressed by ARN built from their fixed names, and the
 * Route 53 alias and the DNS-validated certificate are created and deleted
 * with the stack, so a redeploy needs no manual DNS step.
 *
 * Cost shape: public subnets, public IP on the task, no NAT gateway. The
 * task accepts traffic only from the ALB's security group.
 */
export class GatewayStack extends Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    const householdId = props.householdId ?? "household-demo";
    const imageTag: string = this.node.tryGetContext("imageTag") ?? "unset";

    // --- Parameters: values supplied at deploy time ---------------------------

    const domainName = new CfnParameter(this, "DomainName", {
      type: "String",
      description: "Public hostname for the gateway, e.g. gateway.example.com. Must sit inside the hosted zone below.",
      allowedPattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
      constraintDescription: "must be a lowercase DNS hostname",
    });
    const hostedZoneId = new CfnParameter(this, "HostedZoneId", {
      type: "AWS::Route53::HostedZone::Id",
      description: "Route 53 hosted zone that contains DomainName. Certificate validation and the alias record are written here.",
    });
    const hostedZoneName = new CfnParameter(this, "HostedZoneName", {
      type: "String",
      description: "The hosted zone's name, e.g. example.com.",
    });
    const upstreamsJson = new CfnParameter(this, "UpstreamsJson", {
      type: "String",
      description: 'CHAPERONE_UPSTREAMS: JSON array of {"id","url","label"}.',
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: hostedZoneId.valueAsString,
      zoneName: hostedZoneName.valueAsString,
    });

    // --- Network: public subnets only, no NAT ----------------------------------

    const vpc = new ec2.Vpc(this, "Vpc", {
      // An ALB requires subnets in two AZs. Resolved by CloudFormation (Fn::GetAZs)
      // rather than by a synth-time lookup, so `cdk synth` needs no AWS credentials.
      availabilityZones: [Fn.select(0, Fn.getAzs(this.region)), Fn.select(1, Fn.getAzs(this.region))],
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    // --- Cluster, logs, task ------------------------------------------------------

    const logGroup = new logs.LogGroup(this, "GatewayLogs", {
      logGroupName: "/chaperone/gateway",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: "chaperone" });

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    for (const schema of TABLE_SCHEMAS) {
      const actions = GATEWAY_GRANTS[schema.logicalName];
      if (actions === undefined) continue;
      const arn = this.formatArn({ service: "dynamodb", resource: "table", resourceName: `${TABLE_PREFIX}-${schema.logicalName}` });
      taskDef.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: `Gateway${schema.logicalName.replace(/[^A-Za-z0-9]/g, "")}`,
          actions: [...actions],
          resources: schema.gsi ? [arn, `${arn}/index/*`] : [arn],
        }),
      );
    }

    taskDef.addContainer("gateway", {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, imageTag),
      logging: ecs.LogDriver.awsLogs({ logGroup, streamPrefix: "gateway" }),
      portMappings: [{ containerPort: CONTAINER_PORT }],
      environment: {
        PORT: String(CONTAINER_PORT),
        // 0.0.0.0 inside the task; the security group is what limits who can reach it.
        BIND_ALL: "true",
        AWS_REGION: this.region,
        DDB_TABLE_PREFIX: TABLE_PREFIX,
        HOUSEHOLD_ID: householdId,
        CHAPERONE_ENV: "production",
        CHAPERONE_UPSTREAMS: upstreamsJson.valueAsString,
        GATEWAY_ORIGIN_ALLOWLIST: `https://${domainName.valueAsString}`,
        // No DDB_ENDPOINT on purpose: its absence is how /healthz reports "dynamodb-aws".
      },
      // ECS ignores the image's HEALTHCHECK, so the same probe is declared here.
      healthCheck: {
        command: [
          "CMD-SHELL",
          `node -e "fetch('http://127.0.0.1:${CONTAINER_PORT}/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"`,
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(20),
      },
    });

    // --- ALB --------------------------------------------------------------------------

    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc, description: "Chaperone ALB: 80/443 from the internet" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

    const taskSg = new ec2.SecurityGroup(this, "TaskSg", { vpc, description: "Chaperone task: ALB only" });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(CONTAINER_PORT));

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      // 300s so a resumable SSE stream that is quiet between events is not cut by the ALB.
      idleTimeout: Duration.seconds(300),
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // DNS validation written straight into the hosted zone: no manual CNAME,
    // so destroy + redeploy needs no human step.
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: domainName.valueAsString,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskSg],
      minHealthyPercent: 0, // one task: a deploy replaces it in place rather than needing a second
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service],
      // With one task stickiness is moot, but it is what keeps a resumed stream
      // on the task holding the in-flight call registry if the count is raised.
      stickinessCookieDuration: Duration.hours(1),
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: "/healthz",
        healthyHttpCodes: "200",
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    alb.addListener("Https", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultTargetGroups: [targetGroup],
    });
    alb.addListener("HttpRedirect", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", permanent: true }),
    });

    new route53.ARecord(this, "Alias", {
      zone,
      recordName: domainName.valueAsString,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
    });

    new CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "ServiceName", { value: service.serviceName });
    new CfnOutput(this, "ImageTag", { value: imageTag });
  }
}
