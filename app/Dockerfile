# syntax=docker/dockerfile:1
ARG APP=ingest-api
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY apps ./apps
COPY libs ./libs
COPY migrate.ts ./
RUN npm run build

FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine AS runtime
ARG GIT_SHA=unknown
ARG APP_VERSION=0.0.0
ENV NODE_ENV=production APP_ENV=prod GIT_SHA=${GIT_SHA} APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.revision=${GIT_SHA} \
      org.opencontainers.image.version=${APP_VERSION}
WORKDIR /app
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY migrations ./migrations
USER 10001:10001

FROM runtime AS ingest-api
EXPOSE 3000
CMD ["node", "dist/apps/ingest-api/main.js"]

FROM runtime AS processor
EXPOSE 3001
CMD ["node", "dist/apps/processor/main.js"]

# Selecting the stage preserves a literal exec-form CMD for either application.
FROM ${APP} AS final
