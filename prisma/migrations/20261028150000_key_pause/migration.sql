ALTER TABLE "VirtualKey" ADD COLUMN     "paused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pausedUntil" TIMESTAMP(3);
