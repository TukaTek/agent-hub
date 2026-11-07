-- Sole statement in this migration so it runs outside an implicit
-- transaction: CREATE INDEX CONCURRENTLY errors inside one.
-- One row per tool completion audit invocation: a retry of an audit whose
-- transaction already committed hits this index instead of duplicating it.
-- Rows without an auditId (written before this release) stay outside it.
CREATE UNIQUE INDEX CONCURRENTLY "events_runId_auditId_key" ON "events"("runId", (payload->>'auditId')) WHERE type = 'agent.tool.completed' AND "runId" IS NOT NULL AND coalesce(payload->>'auditId', '') <> '';
