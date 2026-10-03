-- Last-known-good Hub policy (CAAH-36), shared by API and worker.
CREATE TABLE "hub_policy_snapshot" (
    "tenant" TEXT NOT NULL,
    "documentCipher" TEXT,
    "revision" INTEGER,
    "etag" TEXT,
    "digest" TEXT,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "assignmentsSource" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hub_policy_snapshot_pkey" PRIMARY KEY ("tenant")
);
