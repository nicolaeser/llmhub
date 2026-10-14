CREATE TABLE "IntegrationBlueprint" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "protocol" TEXT NOT NULL DEFAULT 'rest',
    "specKind" TEXT NOT NULL DEFAULT 'manual',
    "spec" JSONB NOT NULL DEFAULT '{}',
    "authMethods" JSONB NOT NULL DEFAULT '[]',
    "limitations" JSONB NOT NULL DEFAULT '[]',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationBlueprint_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "IntegrationAudience" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    CONSTRAINT "IntegrationAudience_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CompanyIntegration" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "blueprintId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanyIntegration_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyIntegrationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL DEFAULT 'none',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'unconfigured',
    "healthCheckedAt" TIMESTAMP(3),
    "healthError" TEXT NOT NULL DEFAULT '',
    "providerScopes" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CredentialReference" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "sealedSecret" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CredentialReference_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "EndpointDefinition" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT,
    "companyIntegrationId" TEXT,
    "operationId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "parameters" JSONB NOT NULL DEFAULT '[]',
    "headers" JSONB NOT NULL DEFAULT '{}',
    "requestSchema" JSONB NOT NULL DEFAULT '{}',
    "responseSchema" JSONB NOT NULL DEFAULT '{}',
    "authRequired" BOOLEAN NOT NULL DEFAULT true,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "rateLimit" JSONB,
    "sideEffect" TEXT NOT NULL DEFAULT 'read',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL DEFAULT 'local',
    "protocolExtras" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EndpointDefinition_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ToolDefinition" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT,
    "companyIntegrationId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "inputSchema" JSONB NOT NULL DEFAULT '{}',
    "outputSchema" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "executionPolicy" JSONB NOT NULL DEFAULT '{}',
    "kind" TEXT NOT NULL DEFAULT 'operation',
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ToolDefinition_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ToolVersion" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "graph" JSONB NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "outputSchema" JSONB NOT NULL,
    "policySnapshot" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolVersion_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "HubAgent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HubAgent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PermissionPolicy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "scope" TEXT NOT NULL,
    "blueprintId" TEXT,
    "companyIntegrationId" TEXT,
    "toolId" TEXT,
    "agentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PermissionPolicy_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AgentBinding" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "policyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentBinding_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ToolExecution" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "toolId" TEXT NOT NULL,
    "toolVersion" INTEGER NOT NULL DEFAULT 0,
    "agentId" TEXT NOT NULL DEFAULT '',
    "connectionId" TEXT,
    "actor" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "operation" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "summary" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationBlueprint_slug_key" ON "IntegrationBlueprint"("slug");
CREATE UNIQUE INDEX "IntegrationAudience_blueprintId_orgId_key" ON "IntegrationAudience"("blueprintId", "orgId");
CREATE INDEX "IntegrationAudience_orgId_idx" ON "IntegrationAudience"("orgId");
CREATE UNIQUE INDEX "CompanyIntegration_orgId_slug_key" ON "CompanyIntegration"("orgId", "slug");
CREATE INDEX "CompanyIntegration_blueprintId_idx" ON "CompanyIntegration"("blueprintId");
CREATE INDEX "CompanyIntegration_orgId_updatedAt_idx" ON "CompanyIntegration"("orgId", "updatedAt");
CREATE INDEX "Connection_orgId_createdAt_idx" ON "Connection"("orgId", "createdAt");
CREATE INDEX "Connection_companyIntegrationId_idx" ON "Connection"("companyIntegrationId");
CREATE UNIQUE INDEX "CredentialReference_connectionId_key" ON "CredentialReference"("connectionId");
CREATE INDEX "CredentialReference_orgId_idx" ON "CredentialReference"("orgId");
CREATE INDEX "EndpointDefinition_blueprintId_idx" ON "EndpointDefinition"("blueprintId");
CREATE INDEX "EndpointDefinition_companyIntegrationId_idx" ON "EndpointDefinition"("companyIntegrationId");
CREATE UNIQUE INDEX "ToolDefinition_blueprintId_slug_key" ON "ToolDefinition"("blueprintId", "slug");
CREATE UNIQUE INDEX "ToolDefinition_companyIntegrationId_slug_key" ON "ToolDefinition"("companyIntegrationId", "slug");
CREATE INDEX "ToolDefinition_status_idx" ON "ToolDefinition"("status");
CREATE UNIQUE INDEX "ToolVersion_toolId_version_key" ON "ToolVersion"("toolId", "version");
CREATE UNIQUE INDEX "HubAgent_orgId_slug_key" ON "HubAgent"("orgId", "slug");
CREATE INDEX "PermissionPolicy_orgId_idx" ON "PermissionPolicy"("orgId");
CREATE INDEX "PermissionPolicy_scope_idx" ON "PermissionPolicy"("scope");
CREATE UNIQUE INDEX "AgentBinding_agentId_connectionId_toolId_key" ON "AgentBinding"("agentId", "connectionId", "toolId");
CREATE INDEX "AgentBinding_orgId_idx" ON "AgentBinding"("orgId");
CREATE INDEX "AgentBinding_connectionId_idx" ON "AgentBinding"("connectionId");
CREATE INDEX "AgentBinding_toolId_idx" ON "AgentBinding"("toolId");
CREATE INDEX "ApprovalRequest_orgId_status_idx" ON "ApprovalRequest"("orgId", "status");
CREATE INDEX "ApprovalRequest_subjectType_subjectId_idx" ON "ApprovalRequest"("subjectType", "subjectId");
CREATE INDEX "ToolExecution_orgId_startedAt_idx" ON "ToolExecution"("orgId", "startedAt");
CREATE INDEX "ToolExecution_toolId_startedAt_idx" ON "ToolExecution"("toolId", "startedAt");
CREATE INDEX "ToolExecution_status_startedAt_idx" ON "ToolExecution"("status", "startedAt");
ALTER TABLE "IntegrationAudience" ADD CONSTRAINT "IntegrationAudience_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "IntegrationBlueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationAudience" ADD CONSTRAINT "IntegrationAudience_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyIntegration" ADD CONSTRAINT "CompanyIntegration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyIntegration" ADD CONSTRAINT "CompanyIntegration_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "IntegrationBlueprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_companyIntegrationId_fkey" FOREIGN KEY ("companyIntegrationId") REFERENCES "CompanyIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CredentialReference" ADD CONSTRAINT "CredentialReference_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EndpointDefinition" ADD CONSTRAINT "EndpointDefinition_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "IntegrationBlueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EndpointDefinition" ADD CONSTRAINT "EndpointDefinition_companyIntegrationId_fkey" FOREIGN KEY ("companyIntegrationId") REFERENCES "CompanyIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolDefinition" ADD CONSTRAINT "ToolDefinition_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "IntegrationBlueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolDefinition" ADD CONSTRAINT "ToolDefinition_companyIntegrationId_fkey" FOREIGN KEY ("companyIntegrationId") REFERENCES "CompanyIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolVersion" ADD CONSTRAINT "ToolVersion_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ToolDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HubAgent" ADD CONSTRAINT "HubAgent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PermissionPolicy" ADD CONSTRAINT "PermissionPolicy_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "IntegrationBlueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PermissionPolicy" ADD CONSTRAINT "PermissionPolicy_companyIntegrationId_fkey" FOREIGN KEY ("companyIntegrationId") REFERENCES "CompanyIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PermissionPolicy" ADD CONSTRAINT "PermissionPolicy_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ToolDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PermissionPolicy" ADD CONSTRAINT "PermissionPolicy_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "HubAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentBinding" ADD CONSTRAINT "AgentBinding_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "HubAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentBinding" ADD CONSTRAINT "AgentBinding_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentBinding" ADD CONSTRAINT "AgentBinding_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ToolDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentBinding" ADD CONSTRAINT "AgentBinding_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PermissionPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
