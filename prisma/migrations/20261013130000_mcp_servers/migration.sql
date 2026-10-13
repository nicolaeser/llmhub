CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'streamable_http',
    "authType" TEXT NOT NULL DEFAULT 'none',
    "authHeader" TEXT NOT NULL DEFAULT '',
    "authSecret" TEXT NOT NULL DEFAULT '',
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "global" BOOLEAN NOT NULL DEFAULT false,
    "toolsRestricted" BOOLEAN NOT NULL DEFAULT false,
    "allowedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tools" JSONB NOT NULL DEFAULT '[]',
    "refreshedAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "McpAssignment" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "orgId" TEXT,
    "teamId" TEXT,
    "projectId" TEXT,
    "memberId" TEXT,
    "keyId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'allow',
    "blockedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "McpServer_name_key" ON "McpServer"("name");
CREATE INDEX "McpAssignment_orgId_idx" ON "McpAssignment"("orgId");
CREATE INDEX "McpAssignment_teamId_idx" ON "McpAssignment"("teamId");
CREATE INDEX "McpAssignment_projectId_idx" ON "McpAssignment"("projectId");
CREATE INDEX "McpAssignment_memberId_idx" ON "McpAssignment"("memberId");
CREATE INDEX "McpAssignment_keyId_idx" ON "McpAssignment"("keyId");
CREATE UNIQUE INDEX "McpAssignment_serverId_orgId_key" ON "McpAssignment"("serverId", "orgId");
CREATE UNIQUE INDEX "McpAssignment_serverId_teamId_key" ON "McpAssignment"("serverId", "teamId");
CREATE UNIQUE INDEX "McpAssignment_serverId_projectId_key" ON "McpAssignment"("serverId", "projectId");
CREATE UNIQUE INDEX "McpAssignment_serverId_memberId_key" ON "McpAssignment"("serverId", "memberId");
CREATE UNIQUE INDEX "McpAssignment_serverId_keyId_key" ON "McpAssignment"("serverId", "keyId");
ALTER TABLE "McpAssignment" ADD CONSTRAINT "McpAssignment_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpAssignment" ADD CONSTRAINT "McpAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpAssignment" ADD CONSTRAINT "McpAssignment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpAssignment" ADD CONSTRAINT "McpAssignment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpAssignment" ADD CONSTRAINT "McpAssignment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpAssignment" ADD CONSTRAINT "McpAssignment_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "VirtualKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
