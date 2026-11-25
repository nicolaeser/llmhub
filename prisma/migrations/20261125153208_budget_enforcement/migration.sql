-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "budgetMode" TEXT NOT NULL DEFAULT 'soft',
ADD COLUMN     "budgetOverrunPct" INTEGER;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "budgetMode" TEXT NOT NULL DEFAULT 'soft',
ADD COLUMN     "budgetOverrunPct" INTEGER;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "budgetMode" TEXT NOT NULL DEFAULT 'soft',
ADD COLUMN     "budgetOverrunPct" INTEGER;

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "budgetMode" TEXT NOT NULL DEFAULT 'soft',
ADD COLUMN     "budgetOverrunPct" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "budgetMode" TEXT NOT NULL DEFAULT 'soft',
ADD COLUMN     "budgetOverrunPct" INTEGER;

-- AlterTable
ALTER TABLE "VirtualKey" ADD COLUMN     "budgetMode" TEXT NOT NULL DEFAULT 'soft',
ADD COLUMN     "budgetOverrunPct" INTEGER;

-- CreateTable
CREATE TABLE "BudgetHold" (
    "id" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "amount" DECIMAL(20,10) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetHold_entityType_entityId_expiresAt_idx" ON "BudgetHold"("entityType", "entityId", "expiresAt");

-- CreateIndex
CREATE INDEX "BudgetHold_holdId_idx" ON "BudgetHold"("holdId");

-- CreateIndex
CREATE INDEX "BudgetHold_expiresAt_idx" ON "BudgetHold"("expiresAt");
