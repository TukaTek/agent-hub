ALTER TABLE "hub_session" ADD COLUMN "accessToken" TEXT;
ALTER TABLE "hub_session" ALTER COLUMN "audience" DROP NOT NULL;
ALTER TABLE "hub_session" ALTER COLUMN "clientId" DROP NOT NULL;
