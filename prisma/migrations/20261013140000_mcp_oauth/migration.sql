ALTER TABLE "McpServer" ADD COLUMN     "oauthClientId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "oauthGrant" TEXT NOT NULL DEFAULT 'authorization_code',
ADD COLUMN     "oauthScopes" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "protocolVersion" TEXT NOT NULL DEFAULT '';

CREATE TABLE "McpOAuthLogin" (
    "serverId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "tokenEndpoint" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "tokens" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthLogin_pkey" PRIMARY KEY ("serverId")
);

ALTER TABLE "McpOAuthLogin" ADD CONSTRAINT "McpOAuthLogin_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
