#!/usr/bin/env bash
# Drive the demo upstream's control endpoints from inside the host, over SSM.
# They are unauthenticated and deliberately not reachable from the internet
# (deploy/docker-compose.yml publishes no port for demo-upstream, and
# deploy/Caddyfile has no route to it); this runs the request from inside the
# demo-upstream container itself, against its own loopback.
#
#   /opt/chaperone/demo-control.sh mutate   # add_item's description changes (the demo's one scripted change)
#   /opt/chaperone/demo-control.sh reset    # puts it back
#   /opt/chaperone/demo-control.sh stats    # read-only counters
set -euo pipefail

case "${1:-}" in
  mutate) METHOD=POST; ROUTE=/control/mutate ;;
  reset)  METHOD=POST; ROUTE=/control/reset ;;
  stats)  METHOD=GET;  ROUTE=/control/stats ;;
  *) echo "usage: demo-control.sh mutate|reset|stats" >&2; exit 2 ;;
esac

cd "${CHAPERONE_DIR:-/opt/chaperone}"
docker compose exec -T demo-upstream node -e "
fetch('http://127.0.0.1:4000${ROUTE}', { method: '${METHOD}' })
  .then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })
  .catch((e) => { console.error(String(e)); process.exit(1); });
"
