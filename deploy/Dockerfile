# syntax=docker/dockerfile:1.7
# Multi-stage build for wafle-mcp.
# Stage 1: build the TS sources.
# Stage 2: ship a minimal alpine runtime.

ARG NODE_VERSION=20-alpine

FROM node:${NODE_VERSION} AS builder
WORKDIR /build
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --production


FROM node:${NODE_VERSION} AS runtime
RUN addgroup -S wafle && adduser -S wafle -G wafle
WORKDIR /app
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    WAFLE_MCP_HTTP_HOST=0.0.0.0 \
    WAFLE_MCP_HTTP_PORT=7100

COPY --from=builder --chown=wafle:wafle /build/node_modules ./node_modules
COPY --from=builder --chown=wafle:wafle /build/dist ./dist
COPY --chown=wafle:wafle package.json ./

USER wafle
EXPOSE 7100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7100/healthz || exit 1

ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--transport=http"]
