ALTER TABLE "User" ADD COLUMN     "logContent" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "VirtualKey" ADD COLUMN     "logContent" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "RequestLog" ADD COLUMN     "contentSkip" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "deploymentId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "endpoint" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "error" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "piiInput" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "piiMode" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "piiOutput" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "stream" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tag" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "upstreamModel" TEXT NOT NULL DEFAULT '';

CREATE TABLE "RequestLogContent" (
    "logId" TEXT NOT NULL,
    "request" JSONB,
    "response" JSONB,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestLogContent_pkey" PRIMARY KEY ("logId")
);

CREATE INDEX "RequestLogContent_createdAt_idx" ON "RequestLogContent"("createdAt");

CREATE INDEX "RequestLog_userId_idx" ON "RequestLog"("userId");

ALTER TABLE "RequestLogContent" ADD CONSTRAINT "RequestLogContent_logId_fkey" FOREIGN KEY ("logId") REFERENCES "RequestLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

