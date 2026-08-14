-- ---------------------------------------------------------------------------
-- ESPACE DÉVELOPPEUR & FACTURATION PAR QUOTAS (MESSAGES X & MINUTES Y)
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

-- Table developer_api_keys
CREATE TABLE IF NOT EXISTS "developer_api_keys" (
    "key_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "key_hash" VARCHAR(255) NOT NULL,
    "prefix" VARCHAR(15) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "type" "ApiKeyType" NOT NULL DEFAULT 'SANDBOX',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_api_keys_pkey" PRIMARY KEY ("key_id"),
    CONSTRAINT "developer_api_keys_key_hash_key" UNIQUE ("key_hash"),
    CONSTRAINT "developer_api_keys_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
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
