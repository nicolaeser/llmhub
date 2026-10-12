CREATE TABLE "VectorStore" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "projectId" TEXT,
    "memberId" TEXT,
    "userId" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "embeddingModel" TEXT NOT NULL,
    "embeddingDimensions" INTEGER NOT NULL DEFAULT 0,
    "dimensions" INTEGER NOT NULL DEFAULT 0,
    "rerankModel" TEXT NOT NULL DEFAULT '',
    "ocrModel" TEXT NOT NULL DEFAULT '',
    "chunkMaxTokens" INTEGER NOT NULL DEFAULT 800,
    "chunkOverlapTokens" INTEGER NOT NULL DEFAULT 400,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAfterDays" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VectorStore_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VectorStoreFile" (
    "storeId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "filename" TEXT NOT NULL DEFAULT '',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "chunkingType" TEXT NOT NULL DEFAULT 'auto',
    "chunkMaxTokens" INTEGER NOT NULL,
    "chunkOverlapTokens" INTEGER NOT NULL,
    "usageBytes" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" JSONB,
    "ingestBy" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorStoreFile_pkey" PRIMARY KEY ("storeId","fileId")
);

CREATE TABLE "VectorChunk" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "embedding" BYTEA NOT NULL,
    "terms" BYTEA NOT NULL,

    CONSTRAINT "VectorChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VectorStore_orgId_idx" ON "VectorStore"("orgId");

CREATE INDEX "VectorStore_projectId_idx" ON "VectorStore"("projectId");

CREATE INDEX "VectorStore_memberId_idx" ON "VectorStore"("memberId");

CREATE INDEX "VectorStore_userId_idx" ON "VectorStore"("userId");

CREATE INDEX "VectorStore_expiresAt_idx" ON "VectorStore"("expiresAt");

CREATE INDEX "VectorStoreFile_fileId_idx" ON "VectorStoreFile"("fileId");

CREATE INDEX "VectorStoreFile_status_leaseUntil_idx" ON "VectorStoreFile"("status", "leaseUntil");

CREATE INDEX "VectorStoreFile_storeId_batchId_idx" ON "VectorStoreFile"("storeId", "batchId");

CREATE INDEX "VectorChunk_storeId_fileId_position_idx" ON "VectorChunk"("storeId", "fileId", "position");

ALTER TABLE "VectorStore" ADD CONSTRAINT "VectorStore_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VectorStore" ADD CONSTRAINT "VectorStore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VectorStore" ADD CONSTRAINT "VectorStore_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VectorStore" ADD CONSTRAINT "VectorStore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VectorStoreFile" ADD CONSTRAINT "VectorStoreFile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "VectorStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VectorStoreFile" ADD CONSTRAINT "VectorStoreFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VectorChunk" ADD CONSTRAINT "VectorChunk_storeId_fileId_fkey" FOREIGN KEY ("storeId", "fileId") REFERENCES "VectorStoreFile"("storeId", "fileId") ON DELETE CASCADE ON UPDATE CASCADE;
