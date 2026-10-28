CREATE TABLE "SsoSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "sid" TEXT,
    "refreshToken" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SsoSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SsoSession_sessionId_key" ON "SsoSession"("sessionId");
CREATE INDEX "SsoSession_issuer_subject_idx" ON "SsoSession"("issuer", "subject");
CREATE INDEX "SsoSession_issuer_sid_idx" ON "SsoSession"("issuer", "sid");
CREATE INDEX "SsoSession_checkedAt_idx" ON "SsoSession"("checkedAt");
ALTER TABLE "SsoSession" ADD CONSTRAINT "SsoSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
