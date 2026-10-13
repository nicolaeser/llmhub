UPDATE "Role" SET "permissions" = array_remove("permissions", 'assistant:use') WHERE 'assistant:use' = ANY("permissions");

ALTER TABLE "Role" DROP COLUMN "assistantToolsDisabled";
