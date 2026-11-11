FROM node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
RUN apt-get update && apt-get install -y --no-install-recommends gosu tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY --chmod=755 . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @cortexai-agent-hub/db generate
RUN pnpm --filter @cortexai-agent-hub/api --filter @cortexai-agent-hub/worker build
RUN CORTEXAI_AGENT_HUB_ALLOW_DEV_SECRETS=1 pnpm --filter @cortexai-agent-hub/web build
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp
ENV NODE_ENV=production
ENV CORTEXAI_AGENT_HUB_ALLOWED_HOSTS=healthcheck.railway.app
EXPOSE 5173
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["bash", "infra/railway/start.sh"]
