-- NOT VALID lets this commit without scanning the table; VALIDATE runs in the next
-- migration, its own transaction (same pattern as runs_routineId_fkey). SET NULL means a
-- held webhook delivery for a deleted routine continues unattributed instead of creating
-- a run with a dangling routineId.
ALTER TABLE "steering_messages" ADD CONSTRAINT "steering_messages_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
