ALTER TABLE "ModelGroup" ADD COLUMN "extraNames" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "ModelGroup_extraNames_idx" ON "ModelGroup" USING GIN ("extraNames");
