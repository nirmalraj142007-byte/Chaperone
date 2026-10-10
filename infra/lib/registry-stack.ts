import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";

/**
 * The ECR repository, deployed on its own and first. The host pulls from
 * here, and `deploy.sh <sha>` has nothing to pull until an image is pushed,
 * so the image goes up between this stack and the first rollout
 * (docs/RUNBOOK.md, Deploy).
 *
 * Kept alive while the gateway is paused: the image for the redeploy is
 * already here, so resuming is one `cdk deploy`, not a rebuild.
 */
export class RegistryStack extends Stack {
  readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, "GatewayRepo", {
      repositoryName: "chaperone-gateway",
      imageScanOnPush: true,
      // Tags are git shas and are what rollback points at, so they are immutable.
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ description: "keep the last 20 images", maxImageCount: 20 }],
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    new CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
  }
}
