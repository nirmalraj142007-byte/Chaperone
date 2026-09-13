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
EXPOSE 4000
CMD ["node", "packages/demo-upstream/dist/index.js"]
