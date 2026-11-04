# Concord: one container serving the API, MCP endpoint and built web app.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# Only the manifest of the end-to-end tests, so the workspace lockfile matches.
COPY e2e/package.json ./e2e/package.json
RUN pnpm install --frozen-lockfile && pnpm --filter @concord/web build

FROM node:22-bookworm-slim
# git stores each ontology's history; Java + owlready2 give full OWL DL reasoning (HermiT).
RUN apt-get update && apt-get install -y --no-install-recommends git default-jre-headless python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY toolkit ./toolkit
RUN python3 -m venv toolkit/.venv && toolkit/.venv/bin/pip install --no-cache-dir -r toolkit/requirements.txt
ENV NODE_ENV=production CONCORD_DATA_DIR=/data PORT=8787
VOLUME /data
EXPOSE 8787
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
