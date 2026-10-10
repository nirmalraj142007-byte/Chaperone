import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";

/**
 * The ECR repositories, deployed on their own and first. The host pulls from
 * here, and `deploy.sh <sha>` has nothing to pull until the images are pushed,
 * so the images go up between this stack and the first rollout
 * (docs/RUNBOOK.md, Deploy).
 *
 * One repository per image, same git-sha tag on both: a rollout or rollback
 * moves the gateway and the demo upstream together.
 */
export class RegistryStack extends Stack {
  readonly repository: ecr.Repository;
  readonly demoRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const repo = (logicalId: string, repositoryName: string): ecr.Repository =>
      new ecr.Repository(this, logicalId, {
        repositoryName,
        imageScanOnPush: true,
        // Tags are git shas and are what rollback points at, so they are immutable.
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        lifecycleRules: [{ description: "keep the last 20 images", maxImageCount: 20 }],
        removalPolicy: RemovalPolicy.DESTROY,
        emptyOnDelete: true,
      });

    this.repository = repo("GatewayRepo", "chaperone-gateway");
    this.demoRepository = repo("DemoUpstreamRepo", "chaperone-demo-upstream");

    new CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
    new CfnOutput(this, "DemoRepositoryUri", { value: this.demoRepository.repositoryUri });
  }
}
