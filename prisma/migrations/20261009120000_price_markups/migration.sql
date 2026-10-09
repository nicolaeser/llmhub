ALTER TABLE "UsageDaily" ADD COLUMN     "purchaseCost" DECIMAL(20,10) NOT NULL DEFAULT 0;

UPDATE "UsageDaily" SET "purchaseCost" = "cost";

CREATE TABLE "PriceMarkup" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "teamId" TEXT,
    "projectId" TEXT,
    "model" TEXT NOT NULL DEFAULT '',
    "percent" DECIMAL(9,4) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceMarkup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PriceMarkup_orgId_idx" ON "PriceMarkup"("orgId");

CREATE INDEX "PriceMarkup_teamId_idx" ON "PriceMarkup"("teamId");

CREATE INDEX "PriceMarkup_projectId_idx" ON "PriceMarkup"("projectId");

ALTER TABLE "PriceMarkup" ADD CONSTRAINT "PriceMarkup_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PriceMarkup" ADD CONSTRAINT "PriceMarkup_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PriceMarkup" ADD CONSTRAINT "PriceMarkup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
