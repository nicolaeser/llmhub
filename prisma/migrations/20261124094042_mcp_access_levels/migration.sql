-- AlterTable
ALTER TABLE "McpAssignment" ADD COLUMN     "access" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "extraTools" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "McpServer" ADD COLUMN     "globalAccess" TEXT NOT NULL DEFAULT 'all';
