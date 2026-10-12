CREATE TABLE "ProviderLogin" (
    "providerId" TEXT NOT NULL,
    "account" TEXT NOT NULL DEFAULT '',
    "plan" TEXT NOT NULL DEFAULT '',
    "tokens" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderLogin_pkey" PRIMARY KEY ("providerId")
);

ALTER TABLE "ProviderLogin" ADD CONSTRAINT "ProviderLogin_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
