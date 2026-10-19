ALTER TABLE "AccountRouting" ADD COLUMN     "autoReset" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoResetPercent" INTEGER NOT NULL DEFAULT 99,
ADD COLUMN     "autoResetScope" TEXT NOT NULL DEFAULT 'pool';
