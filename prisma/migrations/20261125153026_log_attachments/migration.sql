-- CreateTable
CREATE TABLE "LogAttachment" (
    "id" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "payload" BYTEA,
    "storageKey" TEXT NOT NULL DEFAULT '',
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestLogAttachment" (
    "logId" TEXT NOT NULL,
    "contentCreatedAt" TIMESTAMP(3) NOT NULL,
    "attachmentId" TEXT NOT NULL,

    CONSTRAINT "RequestLogAttachment_pkey" PRIMARY KEY ("logId","contentCreatedAt","attachmentId")
);

-- CreateIndex
CREATE INDEX "LogAttachment_usedAt_idx" ON "LogAttachment"("usedAt");

-- CreateIndex
CREATE INDEX "RequestLogAttachment_attachmentId_idx" ON "RequestLogAttachment"("attachmentId");

-- AddForeignKey
ALTER TABLE "RequestLogAttachment" ADD CONSTRAINT "RequestLogAttachment_logId_contentCreatedAt_fkey" FOREIGN KEY ("logId", "contentCreatedAt") REFERENCES "RequestLogContent"("logId", "createdAt") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLogAttachment" ADD CONSTRAINT "RequestLogAttachment_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "LogAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
