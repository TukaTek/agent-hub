-- Sole statement, own transaction: VALIDATE only needs SHARE UPDATE EXCLUSIVE once the
-- prior migration's NOT VALID constraint has committed.
ALTER TABLE "steering_messages" VALIDATE CONSTRAINT "steering_messages_routineId_fkey";
