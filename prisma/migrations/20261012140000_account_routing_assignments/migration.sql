ALTER TABLE "ProviderConnection" ADD COLUMN     "restricted" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "ProviderAssignment" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "orgId" TEXT,
    "teamId" TEXT,
    "projectId" TEXT,
    "memberId" TEXT,
    "keyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderAssignment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AccountRouting" (
    "kind" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountRouting_pkey" PRIMARY KEY ("kind")
);
CREATE INDEX "ProviderAssignment_orgId_idx" ON "ProviderAssignment"("orgId");
CREATE INDEX "ProviderAssignment_teamId_idx" ON "ProviderAssignment"("teamId");
CREATE INDEX "ProviderAssignment_projectId_idx" ON "ProviderAssignment"("projectId");
CREATE INDEX "ProviderAssignment_memberId_idx" ON "ProviderAssignment"("memberId");
CREATE INDEX "ProviderAssignment_keyId_idx" ON "ProviderAssignment"("keyId");
CREATE UNIQUE INDEX "ProviderAssignment_providerId_orgId_key" ON "ProviderAssignment"("providerId", "orgId");
CREATE UNIQUE INDEX "ProviderAssignment_providerId_teamId_key" ON "ProviderAssignment"("providerId", "teamId");
CREATE UNIQUE INDEX "ProviderAssignment_providerId_projectId_key" ON "ProviderAssignment"("providerId", "projectId");
CREATE UNIQUE INDEX "ProviderAssignment_providerId_memberId_key" ON "ProviderAssignment"("providerId", "memberId");
CREATE UNIQUE INDEX "ProviderAssignment_providerId_keyId_key" ON "ProviderAssignment"("providerId", "keyId");
ALTER TABLE "ProviderAssignment" ADD CONSTRAINT "ProviderAssignment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAssignment" ADD CONSTRAINT "ProviderAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAssignment" ADD CONSTRAINT "ProviderAssignment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAssignment" ADD CONSTRAINT "ProviderAssignment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAssignment" ADD CONSTRAINT "ProviderAssignment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAssignment" ADD CONSTRAINT "ProviderAssignment_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "VirtualKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
