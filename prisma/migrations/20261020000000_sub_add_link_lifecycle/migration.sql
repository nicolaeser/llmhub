ALTER TABLE "SubAddAccount" DROP CONSTRAINT "SubAddAccount_linkId_fkey";
ALTER TABLE "SubAddAccount" ADD COLUMN "label" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "linkId" DROP NOT NULL;
UPDATE "SubAddAccount" SET "label" = "SubAddLink"."label" FROM "SubAddLink" WHERE "SubAddAccount"."linkId" = "SubAddLink"."id";
ALTER TABLE "SubAddAccount" ADD CONSTRAINT "SubAddAccount_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "SubAddLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
DELETE FROM "SubAddLink" WHERE "revokedAt" IS NOT NULL;
ALTER TABLE "SubAddLink" DROP COLUMN "revokedAt";
