# Gateway runtime image. Build context is the repo root (see
# docker-compose.yml) because pnpm workspace deps (@chaperone/config,
# /errors, /ledger, /logger) are sibling packages, not published to a
# registry — copying the whole workspace (via .dockerignore for the
# node_modules/dist/.git noise) and letting pnpm's own workspace resolution
# figure out the dependency graph is simpler and less fragile than hand
# listing which package.json files a selective copy would need.
FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chaperone/gateway... build

FROM node:24-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# What /healthz reports about this build. Baked in here rather than
# discovered at runtime: the runtime image has no .git directory (see
# .dockerignore), and a commit the process guessed would be worse than one
# it admits it does not know. Both default to the same honest "unknown"
# /"0.0.0" the config schema uses when a build does not pass them.
ARG CHAPERONE_COMMIT=unknown
ARG CHAPERONE_VERSION=0.0.0
ENV CHAPERONE_COMMIT=$CHAPERONE_COMMIT
ENV CHAPERONE_VERSION=$CHAPERONE_VERSION

COPY --from=build /repo /repo

# Run as the unprivileged `node` user (uid 1000, ships with the base image).
# The tree stays root-owned and world-readable: the gateway writes nothing
# under /repo, so it has no need to own any of it.
USER node
EXPOSE 3000

# node:24-slim has no curl, so the probe is node's own fetch. It reads the
# PORT the process was configured with and hits loopback, which the process
# is reachable on whether or not BIND_ALL is set. /healthz is 200 unless
# storage is down; a dead upstream is a 200 `degraded` (see health.ts).
# On the EC2 host, deploy/deploy.sh waits on this probe's result (via
# `docker inspect`) before it calls a rollout good, and restores the previous
# image if it never turns healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "packages/gateway/dist/index.js"]
