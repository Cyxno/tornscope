-- Multi-user: anonymous browser sessions + per-key capability detection.
-- Additive, plus one deliberate relaxation: TornAccount.tornId loses its
-- global unique so two browser profiles may connect the same Torn account
-- (rows remain isolated per userId).

-- CreateTable UserSession
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Capabilities detected from /key/info selections, stored per credential.
ALTER TABLE "ApiCredential" ADD COLUMN "capabilities" JSONB;

-- Relax the global unique on TornAccount.tornId (keep a plain index).
DROP INDEX "TornAccount_tornId_key";
CREATE INDEX "TornAccount_tornId_idx" ON "TornAccount"("tornId");
