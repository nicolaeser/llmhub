BEGIN;
CREATE TABLE "ComplianceArchiveRun" (
    "id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "format" TEXT NOT NULL DEFAULT '',
    "bucket" TEXT NOT NULL DEFAULT '',
    "objectKey" TEXT NOT NULL DEFAULT '',
    "manifestKey" TEXT NOT NULL DEFAULT '',
    "rows" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "sha256" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceArchiveRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComplianceArchiveRun_status_nextAttemptAt_idx" ON "ComplianceArchiveRun"("status", "nextAttemptAt");

CREATE INDEX "ComplianceArchiveRun_day_idx" ON "ComplianceArchiveRun"("day");

CREATE UNIQUE INDEX "ComplianceArchiveRun_dataset_day_key" ON "ComplianceArchiveRun"("dataset", "day");
COMMIT;
