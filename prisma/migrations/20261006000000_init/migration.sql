CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "isOwner" BOOLEAN NOT NULL DEFAULT false,
    "roleId" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordChangedAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "orgId" TEXT,
    "teamId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT,
    "name" TEXT,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secondFactor" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActive" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserTotp" (
    "userId" TEXT NOT NULL,
    "secret" TEXT,
    "enabledAt" TIMESTAMP(3),
    "lastTimeStep" INTEGER,
    "pendingSecret" TEXT,
    "pendingAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTotp_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserPasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialIdHash" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "UserPasskey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoginChallenge" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "factor" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "webauthnChallenge" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthCeremony" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthCeremony_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserSecurityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSecurityEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "maxBudget" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "spend" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "budgetDuration" TEXT NOT NULL DEFAULT '',
    "spendResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "alias" TEXT NOT NULL,
    "maxBudget" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "spend" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "budgetDuration" TEXT NOT NULL DEFAULT '',
    "rpmLimit" INTEGER NOT NULL DEFAULT 0,
    "tpmLimit" INTEGER NOT NULL DEFAULT 0,
    "spendResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "teamId" TEXT,
    "alias" TEXT NOT NULL,
    "owner" TEXT NOT NULL DEFAULT '',
    "maxBudget" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "spend" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "budgetDuration" TEXT NOT NULL DEFAULT '',
    "spendResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VirtualKey" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyAlias" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "teamId" TEXT,
    "orgId" TEXT,
    "projectId" TEXT,
    "models" JSONB NOT NULL DEFAULT '[]',
    "maxBudget" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "spend" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "rpmLimit" INTEGER NOT NULL DEFAULT 0,
    "tpmLimit" INTEGER NOT NULL DEFAULT 0,
    "budgetDuration" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3),
    "allowedIps" JSONB NOT NULL DEFAULT '[]',
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "prevHash" TEXT NOT NULL DEFAULT '',
    "prevHashUntil" TIMESTAMP(3),
    "spendResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VirtualKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "discovered" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelGroup" (
    "alias" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'least_inflight',
    "billingMode" TEXT NOT NULL DEFAULT 'routed',
    "overflowGroup" TEXT NOT NULL DEFAULT '',
    "numRetries" INTEGER NOT NULL DEFAULT 0,
    "fallbackGroups" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "ModelGroup_pkey" PRIMARY KEY ("alias")
);

CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "groupAlias" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "weight" INTEGER NOT NULL DEFAULT 1,
    "costInput" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "costOutput" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "providerId" TEXT,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpendEvent" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL DEFAULT '',
    "teamId" TEXT NOT NULL DEFAULT '',
    "orgId" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "deployment" TEXT NOT NULL DEFAULT '',
    "tag" TEXT NOT NULL DEFAULT '',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpendEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageDaily" (
    "day" DATE NOT NULL,
    "keyId" TEXT NOT NULL DEFAULT '',
    "teamId" TEXT NOT NULL DEFAULT '',
    "orgId" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "rateLimited" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" BIGINT NOT NULL DEFAULT 0,
    "promptTokens" BIGINT NOT NULL DEFAULT 0,
    "completionTokens" BIGINT NOT NULL DEFAULT 0,
    "cost" DECIMAL(20,10) NOT NULL DEFAULT 0,

    CONSTRAINT "UsageDaily_pkey" PRIMARY KEY ("day","keyId","teamId","orgId","projectId","userId","model")
);

CREATE TABLE "RequestLog" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL DEFAULT '',
    "teamId" TEXT NOT NULL DEFAULT '',
    "orgId" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL DEFAULT '',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoredObject" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "owner" TEXT NOT NULL DEFAULT '',
    "filename" TEXT NOT NULL DEFAULT '',
    "purpose" TEXT NOT NULL DEFAULT '',
    "contentType" TEXT NOT NULL DEFAULT '',
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "payload" BYTEA,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredObject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TempBudget" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "amount" DECIMAL(20,10) NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TempBudget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GatewayAuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "beforeJson" TEXT NOT NULL DEFAULT '',
    "afterJson" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE INDEX "User_roleId_idx" ON "User"("roleId");

CREATE INDEX "User_orgId_idx" ON "User"("orgId");

CREATE INDEX "User_teamId_idx" ON "User"("teamId");

CREATE UNIQUE INDEX "Role_templateKey_key" ON "Role"("templateKey");

CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

CREATE INDEX "Session_userId_idx" ON "Session"("userId");

CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

CREATE INDEX "RecoveryCode_userId_usedAt_idx" ON "RecoveryCode"("userId", "usedAt");

CREATE UNIQUE INDEX "RecoveryCode_userId_codeHash_key" ON "RecoveryCode"("userId", "codeHash");

CREATE UNIQUE INDEX "UserPasskey_credentialIdHash_key" ON "UserPasskey"("credentialIdHash");

CREATE INDEX "UserPasskey_userId_idx" ON "UserPasskey"("userId");

CREATE UNIQUE INDEX "LoginChallenge_tokenHash_key" ON "LoginChallenge"("tokenHash");

CREATE INDEX "LoginChallenge_userId_idx" ON "LoginChallenge"("userId");

CREATE INDEX "LoginChallenge_expiresAt_idx" ON "LoginChallenge"("expiresAt");

CREATE UNIQUE INDEX "AuthCeremony_tokenHash_key" ON "AuthCeremony"("tokenHash");

CREATE INDEX "AuthCeremony_userId_purpose_idx" ON "AuthCeremony"("userId", "purpose");

CREATE INDEX "AuthCeremony_expiresAt_idx" ON "AuthCeremony"("expiresAt");

CREATE INDEX "UserSecurityEvent_userId_createdAt_idx" ON "UserSecurityEvent"("userId", "createdAt");

CREATE UNIQUE INDEX "PasswordResetToken_hash_key" ON "PasswordResetToken"("hash");

CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

CREATE INDEX "LoginAttempt_key_createdAt_idx" ON "LoginAttempt"("key", "createdAt");

CREATE INDEX "Team_orgId_idx" ON "Team"("orgId");

CREATE INDEX "Project_teamId_idx" ON "Project"("teamId");

CREATE UNIQUE INDEX "VirtualKey_hash_key" ON "VirtualKey"("hash");

CREATE INDEX "VirtualKey_teamId_idx" ON "VirtualKey"("teamId");

CREATE INDEX "VirtualKey_userId_idx" ON "VirtualKey"("userId");

CREATE INDEX "Deployment_groupAlias_idx" ON "Deployment"("groupAlias");

CREATE INDEX "Deployment_providerId_idx" ON "Deployment"("providerId");

CREATE INDEX "SpendEvent_createdAt_idx" ON "SpendEvent"("createdAt");

CREATE INDEX "SpendEvent_keyId_idx" ON "SpendEvent"("keyId");

CREATE INDEX "SpendEvent_model_idx" ON "SpendEvent"("model");

CREATE INDEX "SpendEvent_teamId_idx" ON "SpendEvent"("teamId");

CREATE INDEX "SpendEvent_orgId_idx" ON "SpendEvent"("orgId");

CREATE INDEX "SpendEvent_projectId_idx" ON "SpendEvent"("projectId");

CREATE INDEX "SpendEvent_userId_idx" ON "SpendEvent"("userId");

CREATE INDEX "UsageDaily_day_idx" ON "UsageDaily"("day");

CREATE INDEX "RequestLog_createdAt_idx" ON "RequestLog"("createdAt");

CREATE INDEX "RequestLog_keyId_idx" ON "RequestLog"("keyId");

CREATE INDEX "RequestLog_teamId_idx" ON "RequestLog"("teamId");

CREATE INDEX "RequestLog_orgId_idx" ON "RequestLog"("orgId");

CREATE INDEX "RequestLog_projectId_idx" ON "RequestLog"("projectId");

CREATE INDEX "RequestLog_status_idx" ON "RequestLog"("status");

CREATE INDEX "StoredObject_kind_owner_idx" ON "StoredObject"("kind", "owner");

CREATE INDEX "TempBudget_entityType_entityId_idx" ON "TempBudget"("entityType", "entityId");

CREATE INDEX "GatewayAuditLog_createdAt_idx" ON "GatewayAuditLog"("createdAt");

CREATE INDEX "GatewayAuditLog_objectType_objectId_idx" ON "GatewayAuditLog"("objectType", "objectId");

ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserTotp" ADD CONSTRAINT "UserTotp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserTotp"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserPasskey" ADD CONSTRAINT "UserPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoginChallenge" ADD CONSTRAINT "LoginChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuthCeremony" ADD CONSTRAINT "AuthCeremony_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSecurityEvent" ADD CONSTRAINT "UserSecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Team" ADD CONSTRAINT "Team_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Project" ADD CONSTRAINT "Project_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VirtualKey" ADD CONSTRAINT "VirtualKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VirtualKey" ADD CONSTRAINT "VirtualKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VirtualKey" ADD CONSTRAINT "VirtualKey_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VirtualKey" ADD CONSTRAINT "VirtualKey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_groupAlias_fkey" FOREIGN KEY ("groupAlias") REFERENCES "ModelGroup"("alias") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

