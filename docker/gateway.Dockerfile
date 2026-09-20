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
EXPOSE 3000
CMD ["node", "packages/gateway/dist/index.js"]
