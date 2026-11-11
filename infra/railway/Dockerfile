FROM node:22.23.5-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
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
