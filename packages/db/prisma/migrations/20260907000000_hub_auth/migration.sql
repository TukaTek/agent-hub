CREATE TABLE "hub_identity" (
  "userId" TEXT PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "origin" TEXT NOT NULL,
  "tenant" TEXT NOT NULL,
  "subject" TEXT NOT NULL
);
CREATE UNIQUE INDEX "hub_identity_origin_tenant_subject_key" ON "hub_identity"("origin", "tenant", "subject");

CREATE TABLE "hub_session" (
  "sessionId" TEXT PRIMARY KEY REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "refreshToken" TEXT NOT NULL,
  "accessUntil" TIMESTAMP(3) NOT NULL,
  "audience" TEXT NOT NULL,
  "clientId" TEXT NOT NULL
);
