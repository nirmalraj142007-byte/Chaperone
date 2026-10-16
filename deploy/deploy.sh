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
  # The shell too, not only the file: `set -a` above exported the old values,
  # and compose gives exported variables priority over .env. Without this the
  # first rollout pulled `<repo>:unset` (found on the first real deploy, 2026-10-16).
  export GATEWAY_IMAGE="$1" DEMO_UPSTREAM_IMAGE="$2"
}

# The host's Caddyfile, compose file, demo-control.sh and landing page (site/)
# come from the gateway image being rolled out. It is built from the same
# commit and carries the repo's deploy/ directory at /repo/deploy, so a change
# under deploy/ now ships with `deploy.sh <sha>` and a rollback restores that
# commit's copies too. (Before 2026-10-16 these were written once by the
# first-boot script and a change never reached the host.) deploy.sh itself is
# not replaced: rolling back to an image older than this would install a
# deploy.sh that cannot sync. An image with no /repo/deploy leaves the host's
# files as they are.
CADDY_CHANGED=0
sync_host_files() {
  local image="$1" tmp cid
  tmp=$(mktemp -d)
  if ! cid=$(docker create "${image}" 2>/dev/null); then
    echo "warning: cannot read ${image}; host files left as they are" >&2
    rm -rf "${tmp}"
    return 0
  fi
  if ! docker cp "${cid}:/repo/deploy/." "${tmp}/" >/dev/null 2>&1; then
    echo "warning: ${image} has no /repo/deploy; host files left as they are" >&2
    docker rm "${cid}" >/dev/null || true
    rm -rf "${tmp}"
    return 0
  fi
  docker rm "${cid}" >/dev/null || true
  if ! cmp -s "${tmp}/Caddyfile" Caddyfile; then CADDY_CHANGED=1; fi
  install -m 644 "${tmp}/Caddyfile" Caddyfile
  install -m 644 "${tmp}/docker-compose.yml" docker-compose.yml
  install -m 755 "${tmp}/demo-control.sh" demo-control.sh
  # The directory's contents are replaced, not the directory: Caddy's bind
  # mount holds on to the directory itself.
  mkdir -p site
  find site -mindepth 1 -delete
  if [ -d "${tmp}/site" ]; then cp -R "${tmp}/site/." site/; fi
  rm -rf "${tmp}"
}

# Caddy's Caddyfile is a single-file bind mount. `install` writes a new file,
# which a running container does not see, so a changed Caddyfile means
# recreating the Caddy container. Its certificate lives in the caddy_data
# volume and survives this.
reload_caddy_if_changed() {
  if [ "${CADDY_CHANGED}" = "1" ]; then
    docker compose up -d --no-deps --force-recreate caddy
    CADDY_CHANGED=0
  fi
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
sync_host_files "${NEW_GATEWAY}"
docker compose up -d --remove-orphans
reload_caddy_if_changed

if wait_healthy; then
  echo "deployed gateway=${NEW_GATEWAY} demo-upstream=${NEW_DEMO}"
  # Each image is about 1.1 GB and the disk is 20 GB. Unused ones (the previous
  # tags) are dropped; a rollback pulls the old tag again from ECR.
  docker image prune -af >/dev/null || true
  exit 0
fi

echo "not healthy within 120s; restoring ${PREV_GATEWAY} and ${PREV_DEMO}" >&2
set_images "${PREV_GATEWAY}" "${PREV_DEMO}"
sync_host_files "${PREV_GATEWAY}"
docker compose up -d --remove-orphans || true
reload_caddy_if_changed || true
exit 1
