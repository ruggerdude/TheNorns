# Single-service deploy (Railway): build the web app + server, then run the
# server serving the built web from one process. The runner is NOT built here
# — it runs on the operator's own machine and dials this service outbound.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate

# install with the lockfile for reproducible builds
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/adapters/package.json packages/adapters/
COPY apps/server/package.json apps/server/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# build contracts -> server + web (runner/adapters not needed at deploy)
COPY . .
# Build every package in topological order. The server type-imports from
# @norns/runner and @norns/adapters, so their .d.ts must be built first —
# same as `pnpm run ci` locally. (Runtime image copies only what it runs.)
RUN pnpm -r run build

FROM node:24-slim AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
ENV NODE_ENV=production
ENV NORNS_WEB_DIST=/app/apps/web/dist

# production dependencies only — all workspace manifests present so the
# frozen lockfile validates; --filter installs just the server's prod closure
# (contracts + adapters + fastify + pg + zod — adapters is a real runtime dep
# now that the server calls Anthropic/OpenAI directly for live planning),
# not the type-only runner devdep.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/adapters/package.json packages/adapters/
COPY apps/server/package.json apps/server/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod --filter @norns/server...

COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/adapters/dist packages/adapters/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist

EXPOSE 8787
CMD ["node", "apps/server/dist/main.js"]
