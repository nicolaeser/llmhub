CREATE TABLE "ManagementKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagementKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManagementKey_hash_key" ON "ManagementKey"("hash");

CREATE INDEX "ManagementKey_userId_idx" ON "ManagementKey"("userId");

ALTER TABLE "ManagementKey" ADD CONSTRAINT "ManagementKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

