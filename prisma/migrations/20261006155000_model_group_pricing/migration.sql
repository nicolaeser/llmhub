ALTER TABLE "ModelGroup" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priceInput" DECIMAL(20,10) NOT NULL DEFAULT 0,
ADD COLUMN     "priceOutput" DECIMAL(20,10) NOT NULL DEFAULT 0,
ADD COLUMN     "priceTimeZone" TEXT NOT NULL DEFAULT 'UTC';

CREATE TABLE "ModelPriceWindow" (
    "id" TEXT NOT NULL,
    "groupAlias" TEXT NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "priceInput" DECIMAL(20,10) NOT NULL,
    "priceOutput" DECIMAL(20,10) NOT NULL,

    CONSTRAINT "ModelPriceWindow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModelPriceWindow_groupAlias_idx" ON "ModelPriceWindow"("groupAlias");

ALTER TABLE "ModelPriceWindow" ADD CONSTRAINT "ModelPriceWindow_groupAlias_fkey" FOREIGN KEY ("groupAlias") REFERENCES "ModelGroup"("alias") ON DELETE CASCADE ON UPDATE CASCADE;

