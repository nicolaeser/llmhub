ALTER TABLE "McpServer" ADD COLUMN "template" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "McpRole" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "allTools" BOOLEAN NOT NULL DEFAULT false,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allActions" BOOLEAN NOT NULL DEFAULT false,
    "actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpInstallation" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "authType" TEXT NOT NULL DEFAULT 'bearer',
    "authHeader" TEXT NOT NULL DEFAULT '',
    "authSecret" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpInstallation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "McpAssignment" ADD COLUMN "roleId" TEXT;

CREATE UNIQUE INDEX "McpRole_serverId_key_key" ON "McpRole"("serverId", "key");
CREATE INDEX "McpRole_serverId_idx" ON "McpRole"("serverId");
CREATE UNIQUE INDEX "McpInstallation_serverId_orgId_key" ON "McpInstallation"("serverId", "orgId");
CREATE INDEX "McpInstallation_orgId_idx" ON "McpInstallation"("orgId");
CREATE INDEX "McpAssignment_roleId_idx" ON "McpAssignment"("roleId");

ALTER TABLE "McpRole" ADD CONSTRAINT "McpRole_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpInstallation" ADD CONSTRAINT "McpInstallation_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpInstallation" ADD CONSTRAINT "McpInstallation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpAssignment" ADD CONSTRAINT "McpAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "McpRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
