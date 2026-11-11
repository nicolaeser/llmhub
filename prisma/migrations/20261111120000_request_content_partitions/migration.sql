BEGIN;
ALTER TABLE "RequestLogContent" RENAME TO "RequestLogContent_legacy";
ALTER TABLE "RequestLogContent_legacy" DROP CONSTRAINT "RequestLogContent_pkey";
ALTER TABLE "RequestLogContent_legacy" ADD CONSTRAINT "RequestLogContent_legacy_pkey" PRIMARY KEY ("logId", "createdAt");
ALTER INDEX "RequestLogContent_createdAt_idx" RENAME TO "RequestLogContent_legacy_createdAt_idx";
ALTER TABLE "RequestLogContent_legacy" RENAME CONSTRAINT "RequestLogContent_logId_fkey" TO "RequestLogContent_legacy_logId_fkey";
CREATE TABLE "RequestLogContent" (
    "logId" TEXT NOT NULL,
    "request" JSONB,
    "response" JSONB,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequestLogContent_pkey" PRIMARY KEY ("logId", "createdAt")
) PARTITION BY RANGE ("createdAt");
CREATE INDEX "RequestLogContent_createdAt_idx" ON "RequestLogContent"("createdAt");
ALTER TABLE "RequestLogContent" ADD CONSTRAINT "RequestLogContent_logId_fkey" FOREIGN KEY ("logId") REFERENCES "RequestLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DO $$
BEGIN
  EXECUTE format(
    'ALTER TABLE "RequestLogContent" ATTACH PARTITION "RequestLogContent_legacy" FOR VALUES FROM (MINVALUE) TO (%L)',
    date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
  );
END
$$;
CREATE TABLE "RequestLogContent_default" PARTITION OF "RequestLogContent" DEFAULT;
COMMIT;
