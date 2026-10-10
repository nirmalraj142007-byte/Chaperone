import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { GatewayStack } from "../lib/gateway-stack.js";
import { RegistryStack } from "../lib/registry-stack.js";
import { TablesStack } from "../lib/tables-stack.js";

// One App per template: an App can be synthesized only once.
const gatewayApp = new App();
const registry = new RegistryStack(gatewayApp, "Registry");
const gateway = Template.fromStack(new GatewayStack(gatewayApp, "Gateway", { repository: registry.repository }));
const tables = Template.fromStack(new TablesStack(new App(), "Tables"));

interface Statement {
  Sid?: string;
  Action: string | string[];
  Resource: unknown;
}

function gatewayStatements(): Statement[] {
  const policies = gateway.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );
}

describe("GatewayStack", () => {
  it("never grants Update or Delete on the append-only ledger (CLAUDE.md non-negotiable 6)", () => {
    const ledger = gatewayStatements().find((s) => s.Sid === "Gatewayledgerevent");
    expect(ledger).toBeDefined();
    const actions = ([] as string[]).concat(ledger?.Action ?? []);
    expect(actions.sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]);
  });

  it("grants no wildcard action and no table the gateway does not use", () => {
    const granted = gatewayStatements().filter((s) => s.Sid?.startsWith("Gateway"));
    for (const s of granted) {
      expect(([] as string[]).concat(s.Action).some((a) => a.includes("*"))).toBe(false);
    }
    const sids = granted.map((s) => s.Sid);
    for (const crawlerOnly of ["Gatewaycorpusserver", "Gatewaytoolsnapshot", "Gatewaydriftrecord"]) {
      expect(sids).not.toContain(crawlerOnly);
    }
  });

  it("has no NAT gateway and a 300s ALB idle timeout with stickiness", () => {
    gateway.resourceCountIs("AWS::EC2::NatGateway", 0);
    gateway.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      LoadBalancerAttributes: [
        { Key: "deletion_protection.enabled", Value: "false" },
        { Key: "idle_timeout.timeout_seconds", Value: "300" },
      ],
    });
    gateway.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      TargetGroupAttributes: [
        { Key: "deregistration_delay.timeout_seconds", Value: "30" },
        { Key: "stickiness.enabled", Value: "true" },
        { Key: "stickiness.type", Value: "lb_cookie" },
        { Key: "stickiness.lb_cookie.duration_seconds", Value: "3600" },
      ],
    });
  });

  it("keeps nothing that would block destroy/redeploy: no RETAIN, no tables", () => {
    gateway.resourceCountIs("AWS::DynamoDB::Table", 0);
    for (const r of Object.values(gateway.toJSON().Resources as Record<string, { DeletionPolicy?: string }>)) {
      expect(r.DeletionPolicy).not.toBe("Retain");
    }
  });

  it("takes the domain, zone and upstreams as parameters", () => {
    const params = Object.keys(gateway.toJSON().Parameters as object);
    expect(params).toEqual(expect.arrayContaining(["DomainName", "HostedZoneId", "HostedZoneName", "UpstreamsJson"]));
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
