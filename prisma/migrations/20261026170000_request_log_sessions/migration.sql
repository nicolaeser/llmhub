ALTER TABLE "RequestLog" ADD COLUMN     "agent" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "providerId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "sessionId" TEXT NOT NULL DEFAULT '';

CREATE INDEX "RequestLog_sessionId_createdAt_idx" ON "RequestLog"("sessionId", "createdAt");
