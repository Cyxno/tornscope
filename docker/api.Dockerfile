# TornScope API - multi-stage production build.
# Stage "migrator" runs prisma migrate deploy at container start of the
# compose migration service.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/analytics/package.json packages/analytics/
COPY packages/torn-api/package.json packages/torn-api/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @tornscope/api... --ignore-scripts

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/analytics packages/analytics
COPY packages/torn-api packages/torn-api
COPY packages/database packages/database
COPY apps/api apps/api
RUN pnpm --filter @tornscope/database generate \
  && pnpm --filter @tornscope/api... build

FROM base AS migrator
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
WORKDIR /app/packages/database
CMD ["npx", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S tornscope && adduser -S tornscope -G tornscope
COPY --from=build --chown=tornscope:tornscope /app ./
USER tornscope
EXPOSE 3000
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
