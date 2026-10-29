-- Additive (CAAH-136): pending native Hub SSO sign-ins. The previous release never reads it.
CREATE TABLE "hub_sso_native" (
    "stateKey" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "returnTo" TEXT NOT NULL,
    "appChallenge" TEXT NOT NULL,
    "handoffHash" TEXT,
    "grantCipher" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_sso_native_pkey" PRIMARY KEY ("stateKey")
);

CREATE UNIQUE INDEX "hub_sso_native_handoffHash_key" ON "hub_sso_native"("handoffHash");
CREATE INDEX "hub_sso_native_expiresAt_idx" ON "hub_sso_native"("expiresAt");

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cortexai_agent_hub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "hub_sso_native" TO cortexai_agent_hub_app;
  END IF;
END $$;
