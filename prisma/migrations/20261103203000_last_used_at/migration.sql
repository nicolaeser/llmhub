ALTER TABLE "VirtualKey" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
ALTER TABLE "ProviderLogin" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
UPDATE "VirtualKey" SET "lastUsedAt" = (SELECT MAX("createdAt") FROM "RequestLog" WHERE "RequestLog"."keyId" = "VirtualKey"."id");
UPDATE "ProviderLogin" SET "lastUsedAt" = (SELECT MAX("createdAt") FROM "RequestLog" WHERE "RequestLog"."providerId" = "ProviderLogin"."providerId" AND "RequestLog"."contentSkip" <> 'system');
