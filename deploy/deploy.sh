#!/usr/bin/env bash
# Deploy (or roll back to) one image tag on the EC2 host. Run on the instance,
# normally through SSM Run Command (docs/RUNBOOK.md); there is no SSH.
#
#   /opt/chaperone/deploy.sh <git-sha>
#
# The gateway and the demo upstream are built from the same commit and moved
# together: both repositories carry the same tag. Tags are immutable git shas,
# so "rollback" is just this script with the previous sha. If either container
# is not healthy within 120 s, the previous images are restored automatically
# and the script exits non-zero.
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
cd /opt/chaperone

set -a
# shellcheck disable=SC1091
. ./.env
set +a

PREV_GATEWAY="${GATEWAY_IMAGE}"
PREV_DEMO="${DEMO_UPSTREAM_IMAGE}"
NEW_GATEWAY="${ECR_REPO}:${TAG}"
NEW_DEMO="${DEMO_ECR_REPO}:${TAG}"

aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REPO%%/*}"

set_images() {
  sed -i "s|^GATEWAY_IMAGE=.*|GATEWAY_IMAGE=$1|; s|^DEMO_UPSTREAM_IMAGE=.*|DEMO_UPSTREAM_IMAGE=$2|" .env
}

healthy() {
  local status
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null || true)
  [ "${status}" = "healthy" ]
}

wait_healthy() {
  for _ in $(seq 1 60); do
    if healthy chaperone-gateway-1 && healthy chaperone-demo-upstream-1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

set_images "${NEW_GATEWAY}" "${NEW_DEMO}"
docker compose pull gateway demo-upstream
docker compose up -d --remove-orphans

if wait_healthy; then
  echo "deployed gateway=${NEW_GATEWAY} demo-upstream=${NEW_DEMO}"
  # Each image is about 1.1 GB and the disk is 20 GB. Unused ones (the previous
  # tags) are dropped; a rollback pulls the old tag again from ECR.
  docker image prune -af >/dev/null || true
  exit 0
fi

echo "not healthy within 120s; restoring ${PREV_GATEWAY} and ${PREV_DEMO}" >&2
set_images "${PREV_GATEWAY}" "${PREV_DEMO}"
docker compose up -d --remove-orphans || true
exit 1
