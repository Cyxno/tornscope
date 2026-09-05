# TornScope web - SvelteKit with adapter-node.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @tornscope/web... --ignore-scripts

FROM base AS build
ARG API_BASE_URL=http://api:3000
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV API_BASE_URL=$API_BASE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @tornscope/shared build \
  && pnpm --filter @tornscope/web build

FROM base AS runtime
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=5173
RUN addgroup -S tornscope && adduser -S tornscope -G tornscope
COPY --from=build --chown=tornscope:tornscope /app ./
USER tornscope
EXPOSE 5173
WORKDIR /app/apps/web
CMD ["node", "build/index.js"]
