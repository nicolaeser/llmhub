ALTER TABLE "Organization" ADD COLUMN     "guardrailPolicy" JSONB;

ALTER TABLE "Project" ADD COLUMN     "guardrailPolicy" JSONB,
ADD COLUMN     "piiPolicy" JSONB;

ALTER TABLE "VirtualKey" ADD COLUMN     "guardrailPolicy" JSONB;

ALTER TABLE "RequestLog" ADD COLUMN     "guardInput" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "guardOutput" TEXT[] DEFAULT ARRAY[]::TEXT[];
