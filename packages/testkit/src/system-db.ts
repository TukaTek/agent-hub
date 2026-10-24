// Integration suites connect as the runtime login, so their own fixtures and
// assertions run through this system-scoped client.
export { asSystem } from "@cortexai-agent-hub/db";
