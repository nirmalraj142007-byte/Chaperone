import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { Ec2GatewayStack } from "../lib/ec2-gateway-stack.js";
import { RegistryStack } from "../lib/registry-stack.js";
import { TablesStack } from "../lib/tables-stack.js";

// One App per template: an App can be synthesized only once.
const gatewayApp = new App();
const registry = new RegistryStack(gatewayApp, "Registry");
const gateway = Template.fromStack(new Ec2GatewayStack(gatewayApp, "Gateway", { repository: registry.repository }));
const tables = Template.fromStack(new TablesStack(new App(), "Tables"));

interface Statement {
  Sid?: string;
  Action: string | string[];
}

function statements(): Statement[] {
  const policies = gateway.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );
}

describe("Ec2GatewayStack", () => {
  it("never grants Update or Delete on the append-only ledger (CLAUDE.md non-negotiable 6)", () => {
    const ledger = statements().find((s) => s.Sid === "Gatewayledgerevent");
    expect(ledger).toBeDefined();
    expect(([] as string[]).concat(ledger?.Action ?? []).sort()).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]);
  });

  it("grants no wildcard DynamoDB action and nothing on crawler-only tables", () => {
    const granted = statements().filter((s) => s.Sid?.startsWith("Gateway"));
    for (const s of granted) {
      expect(([] as string[]).concat(s.Action).some((a) => a.includes("*"))).toBe(false);
    }
    const sids = granted.map((s) => s.Sid);
    for (const crawlerOnly of ["Gatewaycorpusserver", "Gatewaytoolsnapshot", "Gatewaydriftrecord"]) {
      expect(sids).not.toContain(crawlerOnly);
    }
  });

  it("is the EC2 design: no ALB, ACM, ECS, NAT or Fargate", () => {
    for (const type of [
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "AWS::CertificateManager::Certificate",
      "AWS::ECS::Cluster",
      "AWS::ECS::Service",
      "AWS::EC2::NatGateway",
    ]) {
      gateway.resourceCountIs(type, 0);
    }
    gateway.resourceCountIs("AWS::EC2::Instance", 1);
    gateway.resourceCountIs("AWS::EC2::EIP", 1);
  });

  it("opens only 80 and 443, never SSH", () => {
    const sgs = gateway.findResources("AWS::EC2::SecurityGroup");
    const ingress = Object.values(sgs).flatMap(
      (r) => (r as { Properties: { SecurityGroupIngress?: { FromPort: number; IpProtocol: string }[] } }).Properties.SecurityGroupIngress ?? [],
    );
    expect(ingress.map((i) => `${i.IpProtocol}/${i.FromPort}`).sort()).toEqual(["tcp/443", "tcp/80", "udp/443"]);
  });

  it("requires IMDSv2 with hop limit 2 so the container can reach the role", () => {
    gateway.hasResourceProperties("AWS::EC2::Instance", {
      MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required", HttpPutResponseHopLimit: 2 },
    });
  });

  it("keeps logs for 30 days and retains nothing, so it can be destroyed cleanly", () => {
    gateway.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
    gateway.resourceCountIs("AWS::DynamoDB::Table", 0);
    for (const r of Object.values(gateway.toJSON().Resources as Record<string, { DeletionPolicy?: string }>)) {
      expect(r.DeletionPolicy).not.toBe("Retain");
    }
  });

  it("takes the domain, zone and upstreams as parameters", () => {
    const params = Object.keys(gateway.toJSON().Parameters as object);
    expect(params).toEqual(
      expect.arrayContaining(["DomainName", "HostedZoneId", "HostedZoneName", "UpstreamsJson", "InstanceType"]),
    );
  });

  it("embeds a Caddyfile with no compression and no write timeout", () => {
    const userData = JSON.stringify(gateway.findResources("AWS::EC2::Instance"));
    expect(userData).toContain("flush_interval -1");
    expect(userData).not.toMatch(/\\n\s*encode\s/);
    expect(userData).not.toMatch(/\bwrite\s+\d/);
  });
});

describe("TablesStack", () => {
  it("creates the 7 non-advisory tables, all RETAIN", () => {
    const found = tables.findResources("AWS::DynamoDB::Table");
    expect(Object.keys(found)).toHaveLength(7);
    for (const r of Object.values(found)) expect((r as { DeletionPolicy: string }).DeletionPolicy).toBe("Retain");
    const names = Object.values(found).map((r) => (r as { Properties: { TableName: string } }).Properties.TableName);
    expect(names).not.toContain("chaperone-quarantine");
    expect(names).not.toContain("chaperone-advisory");
  });
});
