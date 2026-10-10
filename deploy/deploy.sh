#!/usr/bin/env bash
# Deploy (or roll back to) one image tag on the EC2 host. Run on the instance,
# normally through SSM Run Command (docs/RUNBOOK.md); there is no SSH.
#
#   /opt/chaperone/deploy.sh <git-sha>
#
# Tags are immutable git shas, so "rollback" is just this script with the
# previous sha. If the new gateway does not turn healthy within 120 s, the
# previous image is restored automatically and the script exits non-zero.
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
cd /opt/chaperone

set -a
# shellcheck disable=SC1091
. ./.env
set +a

PREV_IMAGE="${GATEWAY_IMAGE}"
NEW_IMAGE="${ECR_REPO}:${TAG}"

aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REPO%%/*}"

set_image() { sed -i "s|^GATEWAY_IMAGE=.*|GATEWAY_IMAGE=$1|" .env; }

wait_healthy() {
  for _ in $(seq 1 60); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' chaperone-gateway-1 2>/dev/null || true)
    [ "${status}" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

set_image "${NEW_IMAGE}"
docker compose pull gateway
docker compose up -d --remove-orphans

if wait_healthy; then
  echo "deployed ${NEW_IMAGE}"
  exit 0
fi

echo "gateway not healthy within 120s; restoring ${PREV_IMAGE}" >&2
set_image "${PREV_IMAGE}"
docker compose up -d --remove-orphans || true
exit 1
