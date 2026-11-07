-- ---------------------------------------------------------------------------
-- ESPACE DÉVELOPPEUR : ENSEIGNES, CLÉS, JOURNAL, WEBHOOKS
-- ---------------------------------------------------------------------------
--
-- ⚠️ CE FICHIER DÉCRIT L'ÉTAT CIBLE (07/11/2026). Il est rejoué à chaque
-- déploiement : sur une base neuve il crée les tables telles qu'elles doivent
-- être ; sur la base de production, où elles existent déjà, il ne fait rien.
-- Le passage de l'ancien état au nouveau (suppression des tables mortes et des
-- comptes d'avant les enseignes) est fait par `2026-11_enseignes_developpeur.sql`.
--
-- Une ligne de `developer_accounts` est une ENSEIGNE : `user_id` est le compte
-- Alanya de l'enseigne (type 6), celui qui envoie les messages ;
-- `proprietaire_id` est la personne qui l'a créée et la gère depuis la
-- console. `company_name` porte le nom de l'enseigne.

CREATE TABLE IF NOT EXISTS "developer_accounts" (
    "developer_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "proprietaire_id" UUID NOT NULL,
    "company_name" VARCHAR(100),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_accounts_pkey" PRIMARY KEY ("developer_id"),
    CONSTRAINT "developer_accounts_user_id_key" UNIQUE ("user_id"),
    CONSTRAINT "developer_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "developer_accounts_proprietaire_id_fkey" FOREIGN KEY ("proprietaire_id") REFERENCES "users"("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "developer_api_keys" (
    "key_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "key_hash" VARCHAR(255) NOT NULL,
    "prefix" VARCHAR(15) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_api_keys_pkey" PRIMARY KEY ("key_id"),
    CONSTRAINT "developer_api_keys_key_hash_key" UNIQUE ("key_hash"),
    CONSTRAINT "developer_api_keys_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "developer_api_logs" (
    "log_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "key_prefix" VARCHAR(15),
    "endpoint" VARCHAR(255) NOT NULL,
    "method" VARCHAR(10) NOT NULL DEFAULT 'POST',
    "status_code" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_api_logs_pkey" PRIMARY KEY ("log_id"),
    CONSTRAINT "developer_api_logs_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "developer_webhooks" (
    "webhook_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "developer_id" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "secret_key" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_webhooks_pkey" PRIMARY KEY ("webhook_id"),
    CONSTRAINT "developer_webhooks_developer_id_key" UNIQUE ("developer_id"),
    CONSTRAINT "developer_webhooks_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developer_accounts"("developer_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "developer_api_logs_developer_id_created_at_idx" ON "developer_api_logs"("developer_id", "created_at" DESC);
