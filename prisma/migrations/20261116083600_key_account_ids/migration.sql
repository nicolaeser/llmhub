-- AlterTable
ALTER TABLE "VirtualKey" ADD COLUMN     "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
