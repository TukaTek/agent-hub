import type { Hono } from "hono";

export interface HealthInput {
  deploymentId: string;
  revision: string | null;
  runtime: string;
  sandbox: string;
  composio: boolean;
  pipedream: boolean;
  jobs: string;
  realtime: string;
}

export function createHealthPayload(input: HealthInput) {
  return {
    ok: true as const,
    deploymentId: input.deploymentId,
    revision: input.revision,
    runtime: input.runtime,
    sandbox: input.sandbox,
    composio: input.composio,
    pipedream: input.pipedream,
    jobs: input.jobs,
    realtime: input.realtime,
  };
}

export function mountHealthRoute(app: Hono, input: HealthInput): void {
  app.get("/health", (context) => context.json(createHealthPayload(input)));
}
