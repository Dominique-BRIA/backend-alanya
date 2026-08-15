-- ---------------------------------------------------------------------------
-- Migration 2026-08 : Gestion de la file d'attente active et de son historique
-- Tables : `file` (file active) et `file_historique` (historique, abandons, notes)
-- ---------------------------------------------------------------------------

-- 1. Type Enum pour le statut final du passage en file d'attente
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QueueStatus') THEN
    CREATE TYPE "QueueStatus" AS ENUM (
      'MIS_EN_RELATION',
      'ABANDON',
      'TIMEOUT',
      'REJETE'
    );
  END IF;
END $$;

-- 2. Table de la file d'attente active : file
CREATE TABLE IF NOT EXISTS "file" (
  "idFile"          SERIAL       PRIMARY KEY,
  "idCompany"       INTEGER      NOT NULL,
  "center_alanyaID" UUID         NOT NULL,
  "idService"       INTEGER,
  "idAgent"         UUID,
  "idCustomer"      UUID         NOT NULL,
  "rang"            INTEGER      NOT NULL DEFAULT 1,
  "priorite"        SMALLINT     NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "queue_file_center_customer_key" UNIQUE ("center_alanyaID", "idCustomer")
);

-- Contraintes de clés étrangères idempotentes sur `file`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_idCompany_fkey') THEN
    ALTER TABLE "file"
      ADD CONSTRAINT "file_idCompany_fkey"
      FOREIGN KEY ("idCompany") REFERENCES "company" ("idcompany")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_center_alanyaID_fkey') THEN
    ALTER TABLE "file"
      ADD CONSTRAINT "file_center_alanyaID_fkey"
      FOREIGN KEY ("center_alanyaID") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_idService_fkey') THEN
    ALTER TABLE "file"
      ADD CONSTRAINT "file_idService_fkey"
      FOREIGN KEY ("idService") REFERENCES "service" ("idservice")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_idAgent_fkey') THEN
    ALTER TABLE "file"
      ADD CONSTRAINT "file_idAgent_fkey"
      FOREIGN KEY ("idAgent") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_idCustomer_fkey') THEN
    ALTER TABLE "file"
      ADD CONSTRAINT "file_idCustomer_fkey"
      FOREIGN KEY ("idCustomer") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- Index sur `file`
CREATE INDEX IF NOT EXISTS "queue_file_center_rang_idx" ON "file" ("center_alanyaID", "rang" ASC);
CREATE INDEX IF NOT EXISTS "queue_file_service_rang_idx" ON "file" ("idService", "rang" ASC);
CREATE INDEX IF NOT EXISTS "queue_file_idAgent_idx" ON "file" ("idAgent");

-- 3. Table de l'historique de la file d'attente : file_historique
CREATE TABLE IF NOT EXISTS "file_historique" (
  "idHist"            BIGSERIAL    PRIMARY KEY,
  "idCompany"         INTEGER      NOT NULL,
  "center_alanyaID"   UUID         NOT NULL,
  "idService"         INTEGER,
  "idAgent"           UUID,
  "idCustomer"        UUID         NOT NULL,
  "statut"            "QueueStatus" NOT NULL DEFAULT 'MIS_EN_RELATION',
  "joined_at"         TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "left_at"           TIMESTAMPTZ,
  "attente_duree_sec" INTEGER      NOT NULL DEFAULT 0,
  "appel_duree_sec"   INTEGER      NOT NULL DEFAULT 0,
  "note"              SMALLINT,
  "avis_commentaire"  TEXT
);

-- Contraintes de clés étrangères idempotentes sur `file_historique`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_historique_idCompany_fkey') THEN
    ALTER TABLE "file_historique"
      ADD CONSTRAINT "file_historique_idCompany_fkey"
      FOREIGN KEY ("idCompany") REFERENCES "company" ("idcompany")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_historique_center_alanyaID_fkey') THEN
    ALTER TABLE "file_historique"
      ADD CONSTRAINT "file_historique_center_alanyaID_fkey"
      FOREIGN KEY ("center_alanyaID") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_historique_idService_fkey') THEN
    ALTER TABLE "file_historique"
      ADD CONSTRAINT "file_historique_idService_fkey"
      FOREIGN KEY ("idService") REFERENCES "service" ("idservice")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_historique_idAgent_fkey') THEN
    ALTER TABLE "file_historique"
      ADD CONSTRAINT "file_historique_idAgent_fkey"
      FOREIGN KEY ("idAgent") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_historique_idCustomer_fkey') THEN
    ALTER TABLE "file_historique"
      ADD CONSTRAINT "file_historique_idCustomer_fkey"
      FOREIGN KEY ("idCustomer") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- Index sur `file_historique`
CREATE INDEX IF NOT EXISTS "queue_hist_company_joined_idx" ON "file_historique" ("idCompany", "joined_at" DESC);
CREATE INDEX IF NOT EXISTS "queue_hist_center_joined_idx" ON "file_historique" ("center_alanyaID", "joined_at" DESC);
CREATE INDEX IF NOT EXISTS "queue_hist_service_joined_idx" ON "file_historique" ("idService", "joined_at" DESC);
CREATE INDEX IF NOT EXISTS "queue_hist_agent_joined_idx" ON "file_historique" ("idAgent", "joined_at" DESC);
CREATE INDEX IF NOT EXISTS "queue_hist_statut_idx" ON "file_historique" ("statut");
