ALTER TABLE "McpServer" ADD COLUMN     "toolActions" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "McpRole" ADD COLUMN     "deniedTools" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "McpRole" SET "actions" = ARRAY[]::TEXT[], "allActions" = false WHERE "allTools" = false;

ALTER TABLE "McpRole" DROP COLUMN "allTools";
