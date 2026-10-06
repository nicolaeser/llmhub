ALTER TABLE "User" ADD COLUMN     "budgetDuration" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "maxBudget" DECIMAL(20,10) NOT NULL DEFAULT 0,
ADD COLUMN     "spend" DECIMAL(20,10) NOT NULL DEFAULT 0,
ADD COLUMN     "spendResetAt" TIMESTAMP(3);

UPDATE "User" AS u
SET "orgId" = t."orgId"
FROM "Team" AS t
WHERE u."teamId" = t."id"
  AND t."orgId" IS NOT NULL
  AND u."orgId" IS DISTINCT FROM t."orgId";

UPDATE "VirtualKey" AS k
SET "teamId" = p."teamId"
FROM "Project" AS p
WHERE k."projectId" = p."id"
  AND p."teamId" IS NOT NULL
  AND k."teamId" IS DISTINCT FROM p."teamId";

UPDATE "VirtualKey" AS k
SET "orgId" = t."orgId"
FROM "Team" AS t
WHERE k."teamId" = t."id"
  AND k."orgId" IS DISTINCT FROM t."orgId";
