-- One-time data maintenance that finished on this database (CAAH-71 legacy purge).
CREATE TABLE "maintenance_markers" (
    "name" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_markers_pkey" PRIMARY KEY ("name")
);
