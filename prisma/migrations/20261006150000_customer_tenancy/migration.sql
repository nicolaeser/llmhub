ALTER TABLE "User" DROP CONSTRAINT "User_orgId_fkey";

ALTER TABLE "User" DROP CONSTRAINT "User_teamId_fkey";

ALTER TABLE "VirtualKey" DROP CONSTRAINT "VirtualKey_projectId_fkey";

ALTER TABLE "Project" ADD COLUMN     "orgId" TEXT;

UPDATE "Project" AS p
SET "orgId" = t."orgId"
FROM "Team" AS t
WHERE p."teamId" = t."id"
  AND t."orgId" IS NOT NULL;

ALTER TABLE "VirtualKey" ADD COLUMN     "memberId" TEXT;

ALTER TABLE "SpendEvent" ADD COLUMN     "memberId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "UsageDaily" DROP CONSTRAINT "UsageDaily_pkey",
ADD COLUMN     "memberId" TEXT NOT NULL DEFAULT '',
ADD CONSTRAINT "UsageDaily_pkey" PRIMARY KEY ("day", "keyId", "teamId", "orgId", "projectId", "memberId", "userId", "model");

ALTER TABLE "RequestLog" ADD COLUMN     "memberId" TEXT NOT NULL DEFAULT '';

CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "teamId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "logContent" BOOLEAN NOT NULL DEFAULT true,
    "maxBudget" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "spend" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "budgetDuration" TEXT NOT NULL DEFAULT '',
    "spendResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Member_orgId_idx" ON "Member"("orgId");

CREATE INDEX "Member_teamId_idx" ON "Member"("teamId");

CREATE INDEX "Project_orgId_idx" ON "Project"("orgId");

CREATE INDEX "VirtualKey_orgId_idx" ON "VirtualKey"("orgId");

CREATE INDEX "VirtualKey_projectId_idx" ON "VirtualKey"("projectId");

CREATE INDEX "VirtualKey_memberId_idx" ON "VirtualKey"("memberId");

CREATE INDEX "SpendEvent_memberId_idx" ON "SpendEvent"("memberId");

CREATE INDEX "RequestLog_memberId_idx" ON "RequestLog"("memberId");

INSERT INTO "Project" ("id", "orgId", "teamId", "alias", "owner", "createdAt")
SELECT 'keys_' || t."id", t."orgId", t."id", t."alias" || ' keys', '', CURRENT_TIMESTAMP
FROM "Team" AS t
WHERE t."orgId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "VirtualKey" AS k
    LEFT JOIN "User" AS u ON u."id" = k."userId"
    WHERE k."projectId" IS NULL
      AND COALESCE(k."teamId", u."teamId") = t."id"
  );

UPDATE "VirtualKey" AS k
SET "projectId" = 'keys_' || t."id"
FROM "Team" AS t
WHERE k."projectId" IS NULL
  AND t."orgId" IS NOT NULL
  AND t."id" = COALESCE(k."teamId", (SELECT u."teamId" FROM "User" AS u WHERE u."id" = k."userId"));

INSERT INTO "Project" ("id", "orgId", "teamId", "alias", "owner", "createdAt")
SELECT 'keys_' || o."id", o."id", NULL, o."alias" || ' keys', '', CURRENT_TIMESTAMP
FROM "Organization" AS o
WHERE EXISTS (
  SELECT 1 FROM "VirtualKey" AS k
  JOIN "User" AS u ON u."id" = k."userId"
  WHERE k."projectId" IS NULL
    AND k."teamId" IS NULL
    AND u."orgId" = o."id"
);

UPDATE "VirtualKey" AS k
SET "projectId" = 'keys_' || u."orgId"
FROM "User" AS u
WHERE u."id" = k."userId"
  AND k."projectId" IS NULL
  AND k."teamId" IS NULL
  AND u."orgId" IS NOT NULL;

UPDATE "VirtualKey" AS k
SET "orgId" = p."orgId", "teamId" = p."teamId"
FROM "Project" AS p
WHERE k."projectId" = p."id"
  AND (k."orgId" IS DISTINCT FROM p."orgId" OR k."teamId" IS DISTINCT FROM p."teamId");

UPDATE "VirtualKey"
SET "teamId" = NULL, "orgId" = NULL
WHERE "projectId" IS NULL
  AND "memberId" IS NULL;

UPDATE "User" SET "orgId" = NULL WHERE "orgId" IS NOT NULL;

DROP INDEX "User_teamId_idx";

ALTER TABLE "User" DROP COLUMN "teamId";

ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Member" ADD CONSTRAINT "Member_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Member" ADD CONSTRAINT "Member_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VirtualKey" ADD CONSTRAINT "VirtualKey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VirtualKey" ADD CONSTRAINT "VirtualKey_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
