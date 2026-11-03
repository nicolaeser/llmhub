ALTER TABLE "ProviderConnection" ADD COLUMN     "maxConcurrency" INTEGER,
ADD COLUMN     "adaptiveConcurrency" BOOLEAN NOT NULL DEFAULT false;
