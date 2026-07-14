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
RUN pnpm --filter @norns/contracts run build \
  && pnpm --filter @norns/server run build \
  && pnpm --filter @norns/web run build

FROM node:24-slim AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
ENV NODE_ENV=production
ENV NORNS_WEB_DIST=/app/apps/web/dist

# production dependencies only
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @norns/server... 2>/dev/null || pnpm install --prod

COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist

EXPOSE 8787
CMD ["node", "apps/server/dist/main.js"]
