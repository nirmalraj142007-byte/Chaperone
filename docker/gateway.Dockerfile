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
COPY --from=build /repo /repo
EXPOSE 3000
CMD ["node", "packages/gateway/dist/index.js"]
