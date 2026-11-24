-- AlterTable
ALTER TABLE "ModelGroup" ADD COLUMN     "sessionAffinity" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN     "affinity" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "affinityKey" TEXT NOT NULL DEFAULT '';
