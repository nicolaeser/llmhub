ALTER TABLE "User" ADD COLUMN     "externalId" TEXT;

CREATE TABLE "UserIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScimGroup" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScimGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScimGroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScimGroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

CREATE UNIQUE INDEX "UserIdentity_issuer_subject_key" ON "UserIdentity"("issuer", "subject");

CREATE UNIQUE INDEX "UserIdentity_userId_issuer_key" ON "UserIdentity"("userId", "issuer");

CREATE UNIQUE INDEX "ScimGroup_displayName_key" ON "ScimGroup"("displayName");

CREATE UNIQUE INDEX "ScimGroup_externalId_key" ON "ScimGroup"("externalId");

CREATE INDEX "ScimGroupMember_userId_idx" ON "ScimGroupMember"("userId");

CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId");

ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScimGroupMember" ADD CONSTRAINT "ScimGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ScimGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScimGroupMember" ADD CONSTRAINT "ScimGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
