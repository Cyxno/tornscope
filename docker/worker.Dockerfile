# TornScope worker - same build as the API, different entry point.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/analytics/package.json packages/analytics/
COPY packages/torn-api/package.json packages/torn-api/
COPY packages/database/package.json packages/database/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @tornscope/worker... --ignore-scripts

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/analytics packages/analytics
COPY packages/torn-api packages/torn-api
COPY packages/database packages/database
COPY apps/worker apps/worker
RUN pnpm --filter @tornscope/database generate \
  && pnpm --filter @tornscope/worker... build

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S tornscope && adduser -S tornscope -G tornscope
COPY --from=build --chown=tornscope:tornscope /app ./
USER tornscope
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
