ALTER TABLE "VirtualKey" ADD COLUMN     "accessTimeZone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN     "accessWindows" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "allowedEndpoints" JSONB NOT NULL DEFAULT '[]';
