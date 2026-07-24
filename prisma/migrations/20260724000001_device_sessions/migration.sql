CREATE TABLE "device_sessions" (
 "id" VARCHAR(80) NOT NULL, "userId" UUID NOT NULL, "label" VARCHAR(120) NOT NULL,
 "platform" VARCHAR(16) NOT NULL, "browser" VARCHAR(80), "os" VARCHAR(80),
 "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMPTZ,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "device_sessions_pkey" PRIMARY KEY ("id"));
ALTER TABLE "refresh_tokens" ADD COLUMN "deviceId" VARCHAR(80);
CREATE INDEX "device_sessions_userId_revokedAt_idx" ON "device_sessions"("userId", "revokedAt");
CREATE INDEX "refresh_tokens_deviceId_idx" ON "refresh_tokens"("deviceId");
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
