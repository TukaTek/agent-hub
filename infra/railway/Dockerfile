FROM node:22.23.4-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384
RUN apt-get update && apt-get install -y --no-install-recommends gosu tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY --chmod=755 . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @cortexai-agent-hub/db generate
RUN CORTEXAI_AGENT_HUB_ALLOW_DEV_SECRETS=1 pnpm --filter @cortexai-agent-hub/web build
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp
ENV NODE_ENV=production
ENV CORTEXAI_AGENT_HUB_ALLOWED_HOSTS=healthcheck.railway.app
EXPOSE 5173
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["bash", "infra/railway/start.sh"]
