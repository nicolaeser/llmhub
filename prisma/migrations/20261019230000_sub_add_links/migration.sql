CREATE TABLE "SubAddLink" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxAccounts" INTEGER,
    "added" INTEGER NOT NULL DEFAULT 0,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubAddLink_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SubAddTarget" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "orgId" TEXT,
    "teamId" TEXT,
    "projectId" TEXT,
    "memberId" TEXT,
    "keyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubAddTarget_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SubAddAccount" (
    "providerId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "manageHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubAddAccount_pkey" PRIMARY KEY ("providerId")
);
CREATE UNIQUE INDEX "SubAddLink_tokenHash_key" ON "SubAddLink"("tokenHash");
CREATE INDEX "SubAddLink_createdAt_idx" ON "SubAddLink"("createdAt");
CREATE INDEX "SubAddTarget_orgId_idx" ON "SubAddTarget"("orgId");
CREATE INDEX "SubAddTarget_teamId_idx" ON "SubAddTarget"("teamId");
CREATE INDEX "SubAddTarget_projectId_idx" ON "SubAddTarget"("projectId");
CREATE INDEX "SubAddTarget_memberId_idx" ON "SubAddTarget"("memberId");
CREATE INDEX "SubAddTarget_keyId_idx" ON "SubAddTarget"("keyId");
CREATE UNIQUE INDEX "SubAddTarget_linkId_orgId_key" ON "SubAddTarget"("linkId", "orgId");
CREATE UNIQUE INDEX "SubAddTarget_linkId_teamId_key" ON "SubAddTarget"("linkId", "teamId");
CREATE UNIQUE INDEX "SubAddTarget_linkId_projectId_key" ON "SubAddTarget"("linkId", "projectId");
CREATE UNIQUE INDEX "SubAddTarget_linkId_memberId_key" ON "SubAddTarget"("linkId", "memberId");
CREATE UNIQUE INDEX "SubAddTarget_linkId_keyId_key" ON "SubAddTarget"("linkId", "keyId");
CREATE INDEX "SubAddAccount_linkId_idx" ON "SubAddAccount"("linkId");
CREATE INDEX "SubAddAccount_manageHash_idx" ON "SubAddAccount"("manageHash");
ALTER TABLE "SubAddTarget" ADD CONSTRAINT "SubAddTarget_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "SubAddLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubAddTarget" ADD CONSTRAINT "SubAddTarget_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubAddTarget" ADD CONSTRAINT "SubAddTarget_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubAddTarget" ADD CONSTRAINT "SubAddTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubAddTarget" ADD CONSTRAINT "SubAddTarget_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubAddTarget" ADD CONSTRAINT "SubAddTarget_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "VirtualKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubAddAccount" ADD CONSTRAINT "SubAddAccount_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubAddAccount" ADD CONSTRAINT "SubAddAccount_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "SubAddLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
