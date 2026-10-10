# Staged grocery MCP server. Same build shape as gateway.Dockerfile — see
# that file's comment for why the build context is the full repo.
FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chaperone/demo-upstream... build

FROM node:24-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo

# Unprivileged, like the gateway. The server keeps its state in memory and
# writes nothing under /repo.
USER node
EXPOSE 4000

# /control/stats is the cheapest read-only route that proves the app is
# serving. It is reachable from inside the container's own network only: on
# the EC2 host nothing publishes this port and Caddy has no route to it
# (deploy/Caddyfile, docs/RUNBOOK.md).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/control/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "packages/demo-upstream/dist/index.js"]
