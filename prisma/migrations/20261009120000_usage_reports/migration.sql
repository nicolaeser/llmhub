CREATE TABLE "UsageReport" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "teamId" TEXT,
    "cadence" TEXT NOT NULL DEFAULT 'monthly',
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPeriod" TEXT NOT NULL DEFAULT '',
    "lastSentAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "claimedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UsageReport_orgId_idx" ON "UsageReport"("orgId");

CREATE INDEX "UsageReport_teamId_idx" ON "UsageReport"("teamId");

ALTER TABLE "UsageReport" ADD CONSTRAINT "UsageReport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageReport" ADD CONSTRAINT "UsageReport_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
