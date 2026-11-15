-- AlterTable
ALTER TABLE "RequestLogContent" ADD COLUMN     "sizeBytes" INTEGER;

-- CreateIndex
CREATE INDEX "RequestLogContent_sizeBytes_idx" ON "RequestLogContent"("sizeBytes");
