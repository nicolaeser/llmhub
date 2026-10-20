CREATE TABLE "ProviderLimitSnapshot" (
    "providerId" TEXT NOT NULL,
    "limits" JSONB,
    "resets" JSONB,
    "resetsAt" TIMESTAMP(3),
    "error" TEXT NOT NULL DEFAULT '',
    "fetchedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retryAt" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "loginVersion" INTEGER NOT NULL DEFAULT -1,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderLimitSnapshot_pkey" PRIMARY KEY ("providerId")
);
ALTER TABLE "ProviderLimitSnapshot" ADD CONSTRAINT "ProviderLimitSnapshot_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
