-- Additive: held webhook deliveries remember their routine for run history.
ALTER TABLE "steering_messages" ADD COLUMN "routineId" TEXT;
