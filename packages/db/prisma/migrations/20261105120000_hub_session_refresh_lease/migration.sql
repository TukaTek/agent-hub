-- One refresh per Hub grant across processes, without holding a row lock over Hub I/O (CAAH-108).
ALTER TABLE "hub_session" ADD COLUMN "refreshLeaseUntil" TIMESTAMP(3);
