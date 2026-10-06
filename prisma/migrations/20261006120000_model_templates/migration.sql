ALTER TABLE "ProviderConnection" ADD COLUMN     "noTraining" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "region" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "retentionDays" INTEGER,
ADD COLUMN     "zdr" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ModelTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "models" JSONB NOT NULL DEFAULT '[]',
    "patterns" JSONB NOT NULL DEFAULT '[]',
    "providerIds" JSONB NOT NULL DEFAULT '[]',
    "regions" JSONB NOT NULL DEFAULT '[]',
    "zdrOnly" BOOLEAN NOT NULL DEFAULT false,
    "noTrainingOnly" BOOLEAN NOT NULL DEFAULT false,
    "maxRetentionDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VirtualKeyTemplate" (
    "keyId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,

    CONSTRAINT "VirtualKeyTemplate_pkey" PRIMARY KEY ("keyId","templateId")
);

CREATE UNIQUE INDEX "ModelTemplate_name_key" ON "ModelTemplate"("name");

CREATE INDEX "VirtualKeyTemplate_templateId_idx" ON "VirtualKeyTemplate"("templateId");

ALTER TABLE "VirtualKeyTemplate" ADD CONSTRAINT "VirtualKeyTemplate_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "VirtualKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VirtualKeyTemplate" ADD CONSTRAINT "VirtualKeyTemplate_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ModelTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
