ALTER TABLE "Organization" ADD COLUMN     "labelKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "RequestLog" ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "UsageLabelDaily" (
    "day" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "keyId" TEXT NOT NULL DEFAULT '',
    "teamId" TEXT NOT NULL DEFAULT '',
    "orgId" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT NOT NULL DEFAULT '',
    "memberId" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "rateLimited" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" BIGINT NOT NULL DEFAULT 0,
    "promptTokens" BIGINT NOT NULL DEFAULT 0,
    "completionTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWriteTokens" BIGINT NOT NULL DEFAULT 0,
    "cost" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "cacheSavings" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "purchaseCost" DECIMAL(20,10) NOT NULL DEFAULT 0,

    CONSTRAINT "UsageLabelDaily_pkey" PRIMARY KEY ("day","label","value","keyId","teamId","orgId","projectId","memberId","userId","model")
);

CREATE INDEX "UsageLabelDaily_label_value_day_idx" ON "UsageLabelDaily"("label", "value", "day");

CREATE INDEX "RequestLog_labels_idx" ON "RequestLog" USING GIN ("labels");
