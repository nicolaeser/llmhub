ALTER TABLE "UsageDaily" ADD COLUMN     "responseCacheHits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "responseCacheLookupCost" DECIMAL(20,10) NOT NULL DEFAULT 0,
ADD COLUMN     "responseCacheMisses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "responseCacheSavedCost" DECIMAL(20,10) NOT NULL DEFAULT 0,
ADD COLUMN     "responseCacheSavedTokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "responseCacheSemanticHits" INTEGER NOT NULL DEFAULT 0;
