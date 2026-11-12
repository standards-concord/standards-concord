# Concord: one container serving the API, MCP endpoint and built web app.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY docs/licences ./docs/licences
RUN pnpm install --frozen-lockfile && pnpm --filter @concord/web build

FROM node:22-bookworm-slim
# git stores each ontology's history. OWL reasoning is sparq (WebAssembly, in Node), so no Java.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production CONCORD_DATA_DIR=/data PORT=8787
VOLUME /data
EXPOSE 8787
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
