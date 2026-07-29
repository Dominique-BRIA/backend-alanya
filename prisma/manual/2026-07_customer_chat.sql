-- =============================================================
-- Champ « agent » sur Appareil + table « customerChat »
-- =============================================================
-- Additif et idempotent : rejouable sans risque, y compris par
-- scripts/apply-manual-sql.sh au déploiement.
--
-- Les noms physiques (« ID », « AlanyaID », « start_time », majuscules)
-- reprennent exactement le référentiel, d'où les guillemets. Les noms de champ
-- Prisma restent en camelCase via @map — même approche que l'harmonisation.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_customer_chat.sql

-- -------------------------------------------------------------
-- 1. Appareil.agent
-- -------------------------------------------------------------
-- Nullable à dessein : les lignes déjà en base n'ont pas d'agent, et leur
-- imposer un défaut inventé inscrirait une information fausse là où elle est
-- simplement absente.
ALTER TABLE "Appareil"
  ADD COLUMN IF NOT EXISTS "agent" VARCHAR(50);

-- -------------------------------------------------------------
-- 2. customerChat
-- -------------------------------------------------------------
-- Une ligne par session de discussion client, ouverte à « start_time » et
-- refermée à « end_time ». Un « end_time » nul vaut « session en cours » :
-- inutile d'ajouter une colonne d'état, qui pourrait diverger de la réalité.
--
-- « isFree » suit la convention du projet pour les booléens (SMALLINT 0/1,
-- comme « is_online » ou « destroy ») plutôt qu'un BOOLEAN natif.
--
-- Les deux clés étrangères sont en ON DELETE CASCADE pour que la suppression
-- de compte (DELETE /api/account) reste possible : une contrainte RESTRICT
-- ferait échouer la suppression dès qu'une session existerait.
CREATE TABLE IF NOT EXISTS "customerChat" (
  "ID"         SERIAL PRIMARY KEY,
  "appareilID" INTEGER        NOT NULL,
  "AlanyaID"   UUID           NOT NULL,
  "start_time" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "end_time"   TIMESTAMPTZ(6),
  "isFree"     SMALLINT       NOT NULL DEFAULT 1,
  CONSTRAINT "customerChat_appareilID_fkey"
    FOREIGN KEY ("appareilID") REFERENCES "Appareil"("appareilID") ON DELETE CASCADE,
  CONSTRAINT "customerChat_AlanyaID_fkey"
    FOREIGN KEY ("AlanyaID") REFERENCES "users"("alanyaID") ON DELETE CASCADE
);

-- Les sessions d'un compte, la plus récente d'abord. Son préfixe gauche couvre
-- aussi les recherches sur le seul « AlanyaID » — un second index sur cette
-- colonne serait redondant.
CREATE INDEX IF NOT EXISTS "customerChat_AlanyaID_start_idx"
  ON "customerChat"("AlanyaID", "start_time" DESC);

-- PostgreSQL n'indexe PAS automatiquement les clés étrangères. Sans cet index,
-- chaque suppression d'appareil imposerait un parcours complet de customerChat
-- pour vérifier la cascade.
CREATE INDEX IF NOT EXISTS "customerChat_appareilID_idx"
  ON "customerChat"("appareilID");
