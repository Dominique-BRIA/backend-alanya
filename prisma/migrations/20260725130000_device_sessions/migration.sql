CREATE TABLE IF NOT EXISTS "device_sessions" ("id" VARCHAR(96) PRIMARY KEY,"alanyaID" UUID NOT NULL,"label" VARCHAR(120) NOT NULL,"platform" VARCHAR(24) NOT NULL,"browser" VARCHAR(80),"os" VARCHAR(80),"lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,"revokedAt" TIMESTAMPTZ,"createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_alanyaID_fkey" FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID") ON DELETE CASCADE;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "deviceId" VARCHAR(96);
CREATE INDEX IF NOT EXISTS "device_sessions_alanyaID_revokedAt_idx" ON "device_sessions"("alanyaID","revokedAt");
CREATE INDEX IF NOT EXISTS "refresh_tokens_deviceId_idx" ON "refresh_tokens"("deviceId");
