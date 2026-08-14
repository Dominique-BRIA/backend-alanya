-- ---------------------------------------------------------------------------
-- ESPACE DÉVELOPPEUR, WORKSPACES, TELEMETRIE, WEBHOOKS & FACTURATION PAR QUOTAS
-- ---------------------------------------------------------------------------

-- Types énumérés
DO $$ BEGIN
    CREATE TYPE "ApiKeyType" AS ENUM ('SANDBOX', 'LIVE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TransactionType" AS ENUM ('PURCHASE', 'MESSAGE_SENT', 'CALL_MINUTE', 'HOLD_RESERVE', 'REFUND');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SETTLED', 'CANCELLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Table developer_accounts
CREATE TABLE IF NOT EXISTS "developer_accounts" (
    "developer_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "company_name" VARCHAR(100),
    "balance_credits" BIGINT NOT NULL DEFAULT 1000,
    "hold_credits" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_accounts_pkey" PRIMARY KEY ("developer_id"),
    CONSTRAINT "developer_accounts_user_id_key" UNIQUE ("user_id"),
    CONSTRAINT "developer_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Table developer_workspaces (Multi-Projets)
CREATE TABLE IF NOT EXISTS "developer_workspaces" (
    "workspace_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_workspaces_pkey" PRIMARY KEY ("workspace_id"),
    CONSTRAINT "developer_workspaces_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Table developer_api_keys
CREATE TABLE IF NOT EXISTS "developer_api_keys" (
    "key_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "workspace_id" UUID,
    "key_hash" VARCHAR(255) NOT NULL,
    "prefix" VARCHAR(15) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "type" "ApiKeyType" NOT NULL DEFAULT 'SANDBOX',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_api_keys_pkey" PRIMARY KEY ("key_id"),
    CONSTRAINT "developer_api_keys_key_hash_key" UNIQUE ("key_hash"),
    CONSTRAINT "developer_api_keys_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "developer_api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "developer_workspaces"("workspace_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Assure l'ajout de la colonne workspace_id sur les bases où la table existait déjà
ALTER TABLE "developer_api_keys" ADD COLUMN IF NOT EXISTS "workspace_id" UUID;

-- Table developer_api_logs (Télémétrie & Latence)
CREATE TABLE IF NOT EXISTS "developer_api_logs" (
    "log_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "workspace_id" UUID,
    "key_prefix" VARCHAR(15),
    "endpoint" VARCHAR(255) NOT NULL,
    "method" VARCHAR(10) NOT NULL DEFAULT 'POST',
    "status_code" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_api_logs_pkey" PRIMARY KEY ("log_id"),
    CONSTRAINT "developer_api_logs_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "developer_api_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "developer_workspaces"("workspace_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Table developer_webhooks (Call-backs WhatsApp)
CREATE TABLE IF NOT EXISTS "developer_webhooks" (
    "webhook_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "verify_token" VARCHAR(100),
    "secret_key" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_webhooks_pkey" PRIMARY KEY ("webhook_id"),
    CONSTRAINT "developer_webhooks_developer_id_key" UNIQUE ("developer_id"),
    CONSTRAINT "developer_webhooks_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Table developer_otps (Authentification 2FA)
CREATE TABLE IF NOT EXISTS "developer_otps" (
    "otp_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "recipient_number" VARCHAR(30) NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_otps_pkey" PRIMARY KEY ("otp_id"),
    CONSTRAINT "developer_otps_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Table developer_medias (Standards WhatsApp Media API)
CREATE TABLE IF NOT EXISTS "developer_medias" (
    "media_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_medias_pkey" PRIMARY KEY ("media_id"),
    CONSTRAINT "developer_medias_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Table developer_ledgers
CREATE TABLE IF NOT EXISTS "developer_ledgers" (
    "ledger_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'SETTLED',
    "reference_id" VARCHAR(100),
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_ledgers_pkey" PRIMARY KEY ("ledger_id"),
    CONSTRAINT "developer_ledgers_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Index
CREATE INDEX IF NOT EXISTS "developer_ledgers_developer_id_created_at_idx" ON "developer_ledgers"("developer_id", "created_at");
CREATE INDEX IF NOT EXISTS "developer_api_logs_developer_id_created_at_idx" ON "developer_api_logs"("developer_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "developer_otps_recipient_number_code_idx" ON "developer_otps"("recipient_number", "code");
